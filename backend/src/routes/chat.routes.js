import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { env } from "../config/env.js";
import { query, withTransaction } from "../db/pool.js";
import {
  DEMO_MAX_PDF_BYTES,
  DEMO_MESSAGE_LIMIT,
  crawlDemoWebsite,
  getDemoSessionChatbot,
  indexDemoPdf
} from "../services/demo-chatbot.js";
import { assertCanUseChat } from "../services/entitlements.js";
import { notifyLeadSubmitted } from "../services/email.js";
import { createChatAnswer, createEmbedding } from "../services/openai.js";

const FALLBACK_ANSWER = "I don't have that information in the uploaded business documents or website pages.";
const FALLBACK_PUBLIC_ANSWER = FALLBACK_ANSWER;
const MIN_SIMILARITY = 0.32;

export const chatRouter = express.Router();

const chatLimiter = createChatLimiter({
  windowMs: 60 * 1000,
  visitorLimit: 20,
  clientLimit: 100
});

const demoCrawlLimiter = createChatLimiter({
  windowMs: 60 * 1000,
  visitorLimit: 5,
  clientLimit: 20
});

const demoPdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: DEMO_MAX_PDF_BYTES,
    files: 1
  }
});

chatRouter.post("/", chatLimiter, async (req, res, next) => {
  try {
    const clientId = req.body?.client_id;
    const chatbotKey = normalizeText(req.body?.chatbot_key, 80);
    const rawMessage = String(req.body?.message || "");
    const message = normalizeText(req.body?.message, 1200);
    const sessionId = normalizeSessionId(req.body?.session_id || req.body?.visitor_id) || crypto.randomUUID();

    if (!isUuid(clientId)) {
      return res.status(400).json({ error: "Valid client_id is required." });
    }

    if (!chatbotKey) {
      return res.status(400).json({ error: "Valid chatbot_key is required." });
    }

    if (!message || rawMessage.length > 1200) {
      return res.status(400).json({ error: "Message is required and must be under 1200 characters." });
    }

    const chatbot = await getPublicChatbot({ clientId, chatbotKey });
    if (!chatbot) {
      return res.status(404).json({ error: "Chatbot not found." });
    }

    if (!isOriginAllowed(req.get("origin"), chatbot.website_url)) {
      return res.status(403).json({ error: "This chatbot is not allowed on this website." });
    }

    await assertCanUseChat({ query }, clientId);

    const basicAnswer = getBasicAnswer(message);
    if (basicAnswer) {
      const saved = await saveChatTurn({
        clientId,
        chatbotId: chatbot.id,
        visitorId: sessionId,
        sessionType: "customer",
        visitorMetadata: customerVisitorMetadata(req),
        userMessage: message,
        botAnswer: basicAnswer,
        tokenUsage: 0,
        matchedChunks: [],
        sourceMetadata: { source: "customer", demo: false },
        incrementUsage: true
      });

      return res.json({
        answer: basicAnswer,
        session_id: sessionId,
        chat_session_id: saved.sessionId,
        fallback: false,
        sources: []
      });
    }

    const messageEmbedding = await createEmbedding(message);
    const chunks = await searchClientChunks({
      clientId,
      chatbotId: chatbot.id,
      embedding: messageEmbedding
    });

    const context = chunks.map((chunk, index) => {
      const label = chunk.metadata?.url
        ? `Source ${index + 1} (${chunk.metadata.url})`
        : `Source ${index + 1}`;
      return `${label}:\n${chunk.chunk_text}`;
    }).join("\n\n");
    const answerResult = context
      ? await createChatAnswer({ question: message, context })
      : { answer: FALLBACK_ANSWER, tokenUsage: 0 };
    const fallback = !context || answerResult.answer === FALLBACK_ANSWER;
    const publicAnswer = fallback ? FALLBACK_PUBLIC_ANSWER : answerResult.answer;

    const saved = await saveChatTurn({
      clientId,
      chatbotId: chatbot.id,
      visitorId: sessionId,
      sessionType: "customer",
      visitorMetadata: customerVisitorMetadata(req),
      userMessage: message,
      botAnswer: publicAnswer,
      tokenUsage: answerResult.tokenUsage,
      matchedChunks: chunks,
      sourceMetadata: { source: "customer", demo: false },
      incrementUsage: true
    });

    res.json({
      answer: publicAnswer,
      session_id: sessionId,
      chat_session_id: saved.sessionId,
      fallback,
      sources: chunks.map((chunk) => ({
        id: chunk.id,
        document_id: chunk.document_id,
        source_type: chunk.source_type || chunk.metadata?.source_type || null,
        url: chunk.metadata?.url || null,
        similarity: Number(chunk.similarity)
      }))
    });
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/demo/crawl", demoCrawlLimiter, async (req, res, next) => {
  try {
    const websiteUrl = normalizeText(req.body?.website_url, 2048);
    const sessionId = normalizeSessionId(req.body?.session_id || req.body?.visitor_id) || crypto.randomUUID();

    if (!websiteUrl) {
      return res.status(400).json({ error: "Website URL is required." });
    }

    const result = await crawlDemoWebsite({
      visitorId: sessionId,
      websiteUrl,
      visitorMetadata: demoVisitorMetadata(req)
    });

    res.status(201).json({
      crawled: true,
      session_id: sessionId,
      chat_session_id: result.session.id,
      website_url: result.website_url,
      indexed_pages: result.indexed_pages,
      failed_pages: result.failed_pages,
      max_pages: result.max_pages,
      max_depth: result.max_depth,
      expires_in_hours: 72
    });
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/demo/pdf", demoCrawlLimiter, demoPdfUpload.single("pdf"), async (req, res, next) => {
  try {
    const sessionId = normalizeSessionId(req.body?.session_id || req.body?.visitor_id) || crypto.randomUUID();
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "PDF file is required. Use form field name 'pdf'." });
    }

    if (!isPdfUpload(file)) {
      return res.status(400).json({ error: "Please choose a valid PDF file for this demo." });
    }

    const result = await indexDemoPdf({
      visitorId: sessionId,
      pdfBuffer: file.buffer,
      fileName: normalizeText(file.originalname, 180) || "demo.pdf",
      visitorMetadata: parseJsonMetadata(req.body?.visitor_metadata)
    });

    res.status(201).json({
      uploaded: true,
      session_id: sessionId,
      chat_session_id: result.session.id,
      file_name: result.file_name,
      source_type: result.source_type,
      page_count: result.page_count,
      chunks_created: result.chunks_created,
      chunks_limited: result.chunks_limited,
      max_chunks: result.max_chunks,
      message_limit: DEMO_MESSAGE_LIMIT,
      expires_in_hours: 72
    });
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/demo", chatLimiter, async (req, res, next) => {
  try {
    const rawMessage = String(req.body?.message || "");
    const message = normalizeText(req.body?.message, 1200);
    const sessionId = normalizeSessionId(req.body?.session_id || req.body?.visitor_id) || crypto.randomUUID();

    if (!message || rawMessage.length > 1200) {
      return res.status(400).json({ error: "Message is required and must be under 1200 characters." });
    }

    const demoChatbot = await getDemoSessionChatbot(sessionId);
    if (!demoChatbot) {
      return res.status(400).json({ error: "Submit a website URL or upload a PDF before asking the demo chatbot." });
    }

    const session = await getOrCreateChatSession({
      clientId: demoChatbot.client_id,
      chatbotId: demoChatbot.chatbot_id,
      visitorId: sessionId,
      sessionType: "demo",
      visitorMetadata: demoVisitorMetadata(req)
    });
    const userMessageCount = await countSessionUserMessages(session.id);

    if (userMessageCount >= DEMO_MESSAGE_LIMIT) {
      return res.status(429).json({
        error: "Demo message limit reached.",
        limit_reached: true,
        message_limit: DEMO_MESSAGE_LIMIT,
        chat_session_id: session.id,
        session_id: sessionId
      });
    }

    const messageEmbedding = await createEmbedding(message);
    const chunks = await searchClientChunks({
      clientId: demoChatbot.client_id,
      chatbotId: demoChatbot.chatbot_id,
      embedding: messageEmbedding
    });
    const context = chunks.map((chunk, index) => {
      const label = demoSourceLabel(chunk, index);
      return `${label}:\n${chunk.chunk_text}`;
    }).join("\n\n");
    const answerResult = context
      ? await createChatAnswer({ question: message, context })
      : { answer: getDemoAnswer(message), tokenUsage: 0 };
    const answer = answerResult.answer === FALLBACK_ANSWER
      ? getDemoAnswer(message)
      : answerResult.answer;
    const saved = await saveChatTurn({
      clientId: demoChatbot.client_id,
      chatbotId: demoChatbot.chatbot_id,
      visitorId: sessionId,
      sessionType: "demo",
      visitorMetadata: demoVisitorMetadata(req),
      userMessage: message,
      botAnswer: answer,
      tokenUsage: answerResult.tokenUsage,
      matchedChunks: chunks,
      sourceMetadata: { source: "demo", demo: true },
      incrementUsage: false
    });
    const nextCount = userMessageCount + 1;

    res.json({
      answer,
      session_id: sessionId,
      chat_session_id: saved.sessionId,
      message_count: nextCount,
      message_limit: DEMO_MESSAGE_LIMIT,
      limit_reached: nextCount >= DEMO_MESSAGE_LIMIT,
      fallback: false,
      sources: []
    });
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/lead", chatLimiter, async (req, res, next) => {
  try {
    const clientId = req.body?.client_id;
    const chatbotKey = normalizeText(req.body?.chatbot_key, 80);
    const sessionId = normalizeSessionId(req.body?.session_id || req.body?.visitor_id) || null;
    const chatSessionId = isUuid(req.body?.chat_session_id) ? req.body.chat_session_id : null;
    const name = normalizeText(req.body?.name, 120);
    const email = normalizeEmail(req.body?.email);
    const phone = normalizeText(req.body?.phone, 40);
    const question = normalizeText(req.body?.question, 1200);
    const sourceUrl = normalizeOptionalUrl(req.body?.source_url);

    if (!isUuid(clientId)) {
      return res.status(400).json({ error: "Chatbot setup is invalid. Please refresh this page and try again." });
    }

    if (!chatbotKey) {
      return res.status(400).json({ error: "Chatbot setup is missing. Please contact the business owner." });
    }

    if (!email && !phone) {
      return res.status(400).json({ error: "Please share either an email address or phone number." });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const chatbot = await getPublicChatbot({ clientId, chatbotKey });
    if (!chatbot) {
      return res.status(404).json({ error: "Chatbot is not available right now." });
    }

    if (!isOriginAllowed(req.get("origin"), chatbot.website_url)) {
      return res.status(403).json({ error: "This chatbot is not allowed on this website." });
    }

    await query(
      `
        INSERT INTO chat_leads (
          client_id,
          chatbot_id,
          chat_session_id,
          visitor_id,
          name,
          email,
          phone,
          question,
          source_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        clientId,
        chatbot.id,
        chatSessionId,
        sessionId,
        name || null,
        email || null,
        phone || null,
        question || null,
        sourceUrl
      ]
    );

    notifyLeadSubmitted({
      client: {
        email: chatbot.client_email,
        company_name: chatbot.company_name
      },
      lead: {
        name,
        email,
        phone,
        question,
        sourceUrl
      }
    }).catch((error) => {
      console.error("Lead notification failed:", error);
    });

    res.status(201).json({
      saved: true,
      message: "Thanks. The business team has received your contact details."
    });
  } catch (error) {
    next(error);
  }
});

async function getPublicChatbot({ clientId, chatbotKey }) {
  const result = await query(
    `
      SELECT cb.id, cb.client_id, cb.website_url, c.email AS client_email, c.company_name
      FROM chatbots cb
      JOIN clients c ON c.id = cb.client_id
      WHERE cb.client_id = $1
        AND cb.public_embed_key = $2
        AND cb.is_active = true
      ORDER BY cb.created_at ASC
      LIMIT 1
    `,
    [clientId, chatbotKey]
  );

  return result.rows[0] || null;
}

async function searchClientChunks({ clientId, chatbotId, embedding }) {
  const result = await query(
    `
      SELECT id, document_id, chunk_text, metadata, metadata->>'source_type' AS source_type, similarity
      FROM match_document_chunks($3::vector, $1::uuid, $2::uuid, 6, $4::double precision)
    `,
    [clientId, chatbotId, vectorToSql(embedding), MIN_SIMILARITY]
  );

  return result.rows;
}

async function saveChatTurn({
  clientId,
  chatbotId,
  visitorId,
  sessionType,
  visitorMetadata,
  userMessage,
  botAnswer,
  tokenUsage,
  matchedChunks,
  sourceMetadata,
  incrementUsage
}) {
  return withTransaction(async (db) => {
    const session = await getOrCreateChatSession(
      { clientId, chatbotId, visitorId, sessionType, visitorMetadata },
      db
    );

    await db.query(
      `
        INSERT INTO messages (session_id, client_id, chatbot_id, sender_type, message_text, token_usage, metadata)
        VALUES ($1, $2, $3, 'user', $4, 0, $5)
      `,
      [session.id, clientId, chatbotId, userMessage, sourceMetadata || {}]
    );

    await db.query(
      `
        INSERT INTO messages (session_id, client_id, chatbot_id, sender_type, message_text, token_usage, metadata)
        VALUES ($1, $2, $3, 'bot', $4, $5, $6)
      `,
      [
        session.id,
        clientId,
        chatbotId,
        botAnswer,
        tokenUsage,
        {
          ...(sourceMetadata || {}),
          matched_chunk_ids: matchedChunks.map((chunk) => chunk.id),
          similarities: matchedChunks.map((chunk) => Number(chunk.similarity))
        }
      ]
    );

    if (incrementUsage !== false) {
      const month = new Date();
      month.setUTCDate(1);
      month.setUTCHours(0, 0, 0, 0);

      await db.query(
        `
          INSERT INTO usage_tracking (client_id, month, chatbot_messages_count, token_used)
          VALUES ($1, $2, 1, $3)
          ON CONFLICT (client_id, month)
          DO UPDATE SET
            chatbot_messages_count = usage_tracking.chatbot_messages_count + 1,
            token_used = usage_tracking.token_used + EXCLUDED.token_used,
            updated_at = now()
        `,
        [clientId, month.toISOString().slice(0, 10), tokenUsage]
      );
    }

    return { sessionId: session.id };
  });
}

async function getOrCreateChatSession({ clientId, chatbotId, visitorId, sessionType, visitorMetadata }, db = { query }) {
  let session = (await db.query(
    `
      SELECT id
      FROM chat_sessions
      WHERE client_id = $1
        AND chatbot_id = $2
        AND visitor_id = $3
        AND session_type = $4
        AND started_at > now() - interval '24 hours'
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [clientId, chatbotId, visitorId, sessionType]
  )).rows[0];

  if (!session) {
    session = (await db.query(
      `
        INSERT INTO chat_sessions (client_id, chatbot_id, session_type, visitor_id, visitor_metadata, last_message_at)
        VALUES ($1, $2, $3, $4, $5, now())
        RETURNING id
      `,
      [clientId, chatbotId, sessionType, visitorId, visitorMetadata || {}]
    )).rows[0];
  } else {
    await db.query(
      `
        UPDATE chat_sessions
        SET last_message_at = now(),
            visitor_metadata = visitor_metadata || $2::jsonb
        WHERE id = $1
      `,
      [session.id, visitorMetadata || {}]
    );
  }

  return session;
}

async function countSessionUserMessages(sessionId) {
  const result = await query(
    "SELECT count(*)::int AS message_count FROM messages WHERE session_id = $1 AND sender_type = 'user'",
    [sessionId]
  );

  return Number(result.rows[0]?.message_count || 0);
}

function vectorToSql(embedding) {
  return `[${embedding.join(",")}]`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

function normalizeText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value) {
  return normalizeText(value, 254).toLowerCase();
}

function normalizeOptionalUrl(value) {
  const raw = normalizeText(value, 2048);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.href;
  } catch (_error) {
    return null;
  }
}

function parseJsonMetadata(value) {
  if (!value) return {};
  if (typeof value === "object") return value;

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isPdfUpload(file) {
  const hasPdfExtension = String(file.originalname || "").toLowerCase().endsWith(".pdf");
  const allowedMimeType = ["application/pdf", "application/octet-stream"].includes(String(file.mimetype || "").toLowerCase());
  const hasPdfMagicBytes = file.buffer?.subarray(0, 5).toString("ascii") === "%PDF-";

  return hasPdfExtension && allowedMimeType && hasPdfMagicBytes;
}

function demoSourceLabel(chunk, index) {
  const sourceType = chunk.source_type || chunk.metadata?.source_type || "";

  if (sourceType === "website" && chunk.metadata?.url) {
    return `Website source ${index + 1} (${chunk.metadata.url})`;
  }

  if (sourceType === "website") {
    return `Website source ${index + 1}`;
  }

  if (sourceType === "pdf_text" || sourceType === "ocr") {
    const fileName = chunk.metadata?.file_name ? ` (${chunk.metadata.file_name})` : "";
    return `PDF source ${index + 1}${fileName}`;
  }

  return `Source ${index + 1}`;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function normalizeSessionId(value) {
  const sessionId = String(value || "").trim().slice(0, 100);
  return /^[a-z0-9:_-]{12,100}$/i.test(sessionId) ? sessionId : "";
}

function customerVisitorMetadata(req) {
  return {
    source: "customer",
    demo: false,
    page: normalizeOptionalUrl(req.body?.source_url) || null,
    user_agent: normalizeText(req.get("user-agent"), 300) || null
  };
}

function demoVisitorMetadata(req) {
  const metadata = req.body?.visitor_metadata && typeof req.body.visitor_metadata === "object"
    ? req.body.visitor_metadata
    : {};

  return {
    page: "homepage",
    source: "demo_chat",
    demo: true,
    device: normalizeText(metadata.device, 80) || null,
    referrer: normalizeOptionalUrl(metadata.referrer) || null,
    utm_source: normalizeText(metadata.utm_source, 120) || null,
    utm_campaign: normalizeText(metadata.utm_campaign, 120) || null,
    utm_term: normalizeText(metadata.utm_term, 120) || null,
    user_agent: normalizeText(req.get("user-agent"), 300) || null
  };
}

function getDemoAnswer(message) {
  const normalized = normalizeText(message, 180).toLowerCase();

  if (normalized.includes("price") || normalized.includes("cost") || normalized.includes("charge") || normalized.includes("fee")) {
    return "Custom AI Chatbot offers a Basic plan for PDF-based chatbot setup. Check the pricing section on this website for the current monthly price and plan details.";
  }
  if (normalized.includes("pdf") || normalized.includes("upload") || normalized.includes("document")) {
    return "The product lets customers upload business PDFs so the chatbot can answer website visitor questions from those documents.";
  }
  if (normalized.includes("widget") || normalized.includes("embed") || normalized.includes("script") || normalized.includes("install")) {
    return "After setup, the dashboard provides one chatbot script that can be embedded on a website.";
  }
  if (normalized.includes("support") || normalized.includes("contact") || normalized.includes("help")) {
    return "For support, use the contact details shown on this website.";
  }
  if (normalized.includes("setup") || normalized.includes("start") || normalized.includes("how")) {
    return "The setup flow is: start Basic, upload your business PDFs, then copy the chatbot script into your website.";
  }

  return "This demo answers from the submitted website. Try asking about services, pricing, features, setup, contact details, or support information found on that site.";
}

function getBasicAnswer(message) {
  const normalized = normalizeText(message, 80).toLowerCase();

  if (/^(hi|hello|hey|namaste|good morning|good afternoon|good evening)\b[!. ]*$/.test(normalized)) {
    return "Hi!";
  }

  if (/^(thanks|thank you|ok|okay)\b[!. ]*$/.test(normalized)) {
    return "You're welcome.";
  }

  return null;
}

function createChatLimiter({ windowMs, visitorLimit, clientLimit }) {
  const buckets = new Map();

  return function limitChat(req, res, next) {
    const clientId = isUuid(req.body?.client_id) ? req.body.client_id : "unknown";
    const sessionId = normalizeSessionId(req.body?.session_id || req.body?.visitor_id);
    const limits = [
      { key: `client:${clientId}:global`, limit: clientLimit },
      { key: `client:${clientId}:ip:${req.ip || "unknown"}`, limit: visitorLimit }
    ];

    if (sessionId) {
      limits.push({ key: `client:${clientId}:session:${sessionId}`, limit: visitorLimit });
    }

    const now = Date.now();

    for (const { key, limit } of limits) {
      const bucket = buckets.get(key);
      if (bucket && bucket.resetAt > now && bucket.count >= limit) {
        res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
        return res.status(429).json({ error: "Too many chat messages. Please wait a minute and try again." });
      }
    }

    for (const { key } of limits) {
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
      } else {
        bucket.count += 1;
      }
    }

    next();

    if (buckets.size > 10000) {
      for (const [bucketKey, value] of buckets.entries()) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }
  };
}

function isOriginAllowed(origin, websiteUrl) {
  if (!websiteUrl || !origin) return false;

  try {
    const requestOrigin = new URL(origin).origin;
    const allowedOrigin = new URL(websiteUrl).origin;
    const dashboardOrigin = env.frontendUrl ? new URL(env.frontendUrl).origin : "";

    return requestOrigin === allowedOrigin || requestOrigin === dashboardOrigin;
  } catch (_error) {
    return false;
  }
}
