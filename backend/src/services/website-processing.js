import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { withTransaction } from "../db/pool.js";
import { createEmbedding } from "./openai.js";
import { cleanPdfText, splitTextIntoChunks } from "./pdf-processing.js";

const MAX_DISCOVERED_PAGES = 10;
const MAX_INDEX_PAGES = 10;
const MAX_PAGE_TEXT_CHARS = 80_000;
const MAX_CHUNKS_PER_PAGE = 30;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "CustomAIChatbotBot/1.0 (+https://customaichatbot.online)";

export async function discoverWebsitePages(startUrl) {
  const baseUrl = normalizePublicUrl(startUrl);
  const robots = await getRobotsRules(baseUrl);
  assertAllowedByRobots(baseUrl, robots);

  const html = await fetchHtml(baseUrl);
  const links = extractLinks(html, baseUrl);
  const urls = uniqueUrls([baseUrl.href, ...links])
    .filter((url) => sameOrigin(url, baseUrl))
    .slice(0, MAX_DISCOVERED_PAGES);

  return urls.map((url) => ({ url }));
}

export async function indexWebsitePages({ account, urls }) {
  const baseUrl = normalizePublicUrl(urls[0]);
  const robots = await getRobotsRules(baseUrl);
  const normalizedUrls = uniqueUrls(urls.map((url) => normalizePublicUrl(url).href))
    .filter((url) => sameOrigin(url, baseUrl))
    .slice(0, MAX_INDEX_PAGES);

  if (!normalizedUrls.length) {
    throw Object.assign(new Error("Add at least one public page from the allowed website."), { statusCode: 400 });
  }

  const indexed = [];
  const failed = [];

  for (const url of normalizedUrls) {
    try {
      const pageUrl = normalizePublicUrl(url);
      assertAllowedByRobots(pageUrl, robots);

      const html = await fetchHtml(pageUrl);
      const page = extractPageText(html, pageUrl);
      const chunks = splitTextIntoChunks(page.text).slice(0, MAX_CHUNKS_PER_PAGE);

      if (!chunks.length) {
        throw new Error("No readable text found on this page.");
      }

      const embeddedChunks = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunkText = chunks[index];
        embeddedChunks.push({
          index,
          chunkText,
          embedding: await createEmbedding(chunkText),
          tokenCount: estimateTokens(chunkText)
        });
      }

      const pageRecord = await saveWebsitePage({
        account,
        url: pageUrl.href,
        title: page.title,
        text: page.text,
        chunks: embeddedChunks
      });
      indexed.push(pageRecord);
    } catch (error) {
      const pageRecord = await saveFailedWebsitePage({
        account,
        url,
        errorMessage: userSafeWebsiteError(error)
      });
      failed.push(pageRecord);
    }
  }

  return { indexed, failed };
}

export function normalizePublicUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    throw Object.assign(new Error("Website URL is required."), { statusCode: 400 });
  }

  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw Object.assign(new Error("Enter a valid website URL."), { statusCode: 400 });
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Only public http/https website pages are supported."), { statusCode: 400 });
  }

  assertPublicHostname(url.hostname);
  url.hash = "";
  return url;
}

async function saveWebsitePage({ account, url, title, text, chunks }) {
  return withTransaction(async (db) => {
    const page = (await db.query(
      `
        INSERT INTO website_pages (
          user_id,
          client_id,
          chatbot_id,
          url,
          title,
          status,
          error_message,
          content_hash,
          indexed_at
        )
        VALUES ($1, $2, $3, $4, $5, 'indexed', NULL, $6, now())
        ON CONFLICT (client_id, chatbot_id, url)
        DO UPDATE SET
          title = EXCLUDED.title,
          status = EXCLUDED.status,
          error_message = NULL,
          content_hash = EXCLUDED.content_hash,
          indexed_at = now(),
          updated_at = now()
        RETURNING *
      `,
      [
        account.client.id,
        account.client.id,
        account.chatbot.id,
        url,
        title || null,
        sha256(text)
      ]
    )).rows[0];

    await db.query(
      "DELETE FROM document_chunks WHERE client_id = $1 AND chatbot_id = $2 AND metadata->>'website_page_id' = $3",
      [account.client.id, account.chatbot.id, page.id]
    );

    for (const chunk of chunks) {
      await db.query(
        `
          INSERT INTO document_chunks (
            document_id,
            user_id,
            client_id,
            chatbot_id,
            chunk_index,
            chunk_text,
            embedding,
            token_count,
            page_number,
            source_type,
            ocr_confidence,
            metadata
          )
          VALUES (NULL, $1, $2, $3, $4, $5, $6::vector, $7, NULL, 'website', NULL, $8)
        `,
        [
          account.client.id,
          account.client.id,
          account.chatbot.id,
          chunk.index,
          chunk.chunkText,
          vectorToSql(chunk.embedding),
          chunk.tokenCount,
          {
            website_page_id: page.id,
            url,
            title: title || null,
            chunk_index: chunk.index,
            total_chunks: chunks.length,
            source_type: "website"
          }
        ]
      );
    }

    return { ...page, chunks_created: chunks.length };
  });
}

async function saveFailedWebsitePage({ account, url, errorMessage }) {
  return withTransaction(async (db) => {
    const page = (await db.query(
      `
        INSERT INTO website_pages (
          user_id,
          client_id,
          chatbot_id,
          url,
          status,
          error_message
        )
        VALUES ($1, $2, $3, $4, 'failed', $5)
        ON CONFLICT (client_id, chatbot_id, url)
        DO UPDATE SET
          status = 'failed',
          error_message = EXCLUDED.error_message,
          updated_at = now()
        RETURNING *
      `,
      [account.client.id, account.client.id, account.chatbot.id, url, errorMessage]
    )).rows[0];

    await db.query(
      "DELETE FROM document_chunks WHERE client_id = $1 AND chatbot_id = $2 AND metadata->>'website_page_id' = $3",
      [account.client.id, account.chatbot.id, page.id]
    );

    return page;
  });
}

async function fetchHtml(url) {
  await assertPublicNetworkTarget(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url.href, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      throw new Error(`Page returned HTTP ${response.status}.`);
    }
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error("Page is not HTML.");
    }

    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Page took too long to respond.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertPublicHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
  ) {
    throw Object.assign(new Error("Only public website URLs are supported."), { statusCode: 400 });
  }

  if (net.isIP(normalized) && isPrivateIp(normalized)) {
    throw Object.assign(new Error("Only public website URLs are supported."), { statusCode: 400 });
  }
}

async function assertPublicNetworkTarget(url) {
  assertPublicHostname(url.hostname);

  const records = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!records.length) {
    throw new Error("Website hostname could not be resolved.");
  }

  if (records.some((record) => isPrivateIp(record.address))) {
    throw Object.assign(new Error("Only public website URLs are supported."), { statusCode: 400 });
  }
}

function isPrivateIp(address) {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) return isPrivateIpv4(address);
  if (ipVersion === 6) return isPrivateIpv6(address);
  return false;
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;

  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }

  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
    || normalized.startsWith("2001:db8:");
}

function extractPageText(html, url) {
  const title = cleanInlineText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const text = cleanPdfText(decodeHtmlEntities(withoutNoise.replace(/<[^>]+>/g, "\n"))).slice(0, MAX_PAGE_TEXT_CHARS);

  if (looksBlocked(text)) {
    throw new Error("Page appears to be protected by a bot/security challenge.");
  }

  if (text.replace(/\s/g, "").length < 120) {
    throw new Error("No readable text found on this page.");
  }

  return {
    title: title || url.hostname,
    text
  };
}

function extractLinks(html, baseUrl) {
  const links = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    try {
      const url = new URL(decodeHtmlEntities(match[1]), baseUrl);
      url.hash = "";
      if (["http:", "https:"].includes(url.protocol)) links.push(url.href);
    } catch (_error) {
      // Skip malformed links.
    }
  }

  return links;
}

async function getRobotsRules(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const robotsUrl = new URL("/robots.txt", baseUrl);
    const response = await fetch(robotsUrl.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
      signal: controller.signal
    });
    if (!response.ok) return [];
    return parseRobots(await response.text());
  } catch (_error) {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function parseRobots(text) {
  const rules = [];
  let applies = false;

  for (const line of String(text || "").split(/\r?\n/)) {
    const cleaned = line.replace(/#.*/, "").trim();
    if (!cleaned) continue;

    const separator = cleaned.indexOf(":");
    if (separator === -1) continue;

    const key = cleaned.slice(0, separator).trim().toLowerCase();
    const value = cleaned.slice(separator + 1).trim();

    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("customaichatbotbot");
    } else if (applies && key === "disallow" && value) {
      rules.push(value);
    }
  }

  return rules;
}

function assertAllowedByRobots(url, rules) {
  const blocked = rules.some((rule) => {
    const path = rule.endsWith("*") ? rule.slice(0, -1) : rule;
    return path === "/" || url.pathname.startsWith(path);
  });

  if (blocked) {
    throw Object.assign(new Error("This page is blocked by robots.txt."), { statusCode: 403 });
  }
}

function sameOrigin(value, baseUrl) {
  try {
    return new URL(value).origin === baseUrl.origin;
  } catch (_error) {
    return false;
  }
}

function uniqueUrls(urls) {
  return Array.from(new Set(urls.map((url) => normalizePublicUrl(url).href)));
}

function matchFirst(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
}

function cleanInlineText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim().slice(0, 180);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function looksBlocked(text) {
  const compact = String(text || "").toLowerCase();
  return compact.includes("checking your browser")
    || compact.includes("cloudflare")
    || compact.includes("captcha")
    || compact.includes("access denied")
    || compact.includes("security challenge");
}

function userSafeWebsiteError(error) {
  if (error.statusCode === 403) return error.message;
  return error.message || "Could not read this website page.";
}

function vectorToSql(embedding) {
  return `[${embedding.join(",")}]`;
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
