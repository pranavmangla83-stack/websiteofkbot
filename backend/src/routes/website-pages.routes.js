import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { assertCanUseWebsiteCrawling } from "../services/entitlements.js";
import { syncUserAndTenant } from "../services/accounts.js";
import { discoverWebsitePages, indexWebsitePages, normalizePublicUrl } from "../services/website-processing.js";

export const websitePagesRouter = express.Router();

websitePagesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const result = await query(
      `
        SELECT id, url, title, status, error_message, indexed_at, created_at, updated_at
        FROM website_pages
        WHERE client_id = $1 AND chatbot_id = $2
        ORDER BY updated_at DESC
      `,
      [account.client.id, account.chatbot.id]
    );

    res.json({ pages: result.rows });
  } catch (error) {
    next(error);
  }
});

websitePagesRouter.post("/scan", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const url = req.body?.url || account.chatbot.website_url;
    await assertCanUseWebsiteCrawling({ query }, account);

    if (!url) {
      return res.status(400).json({ error: "Save an allowed website URL before scanning pages." });
    }

    const pages = await discoverWebsitePages(url);
    res.json({ pages });
  } catch (error) {
    next(error);
  }
});

websitePagesRouter.post("/index", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const { entitlement } = await assertCanUseWebsiteCrawling({ query }, account);

    const firstUrl = urls[0];
    const baseUrl = normalizePublicUrl(firstUrl);
    const safeUrls = urls.map((url) => normalizePublicUrl(url).href)
      .filter((url) => new URL(url).origin === baseUrl.origin);
    const allowedUrls = await limitUrlsByWebsitePageEntitlement({ account, entitlement, urls: safeUrls });

    const result = await indexWebsitePages({ account, urls: allowedUrls });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

websitePagesRouter.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const pageId = req.params.id;

    if (!isUuid(pageId)) {
      return res.status(400).json({ error: "Invalid website page id." });
    }

    const deleted = await withTransaction(async (db) => {
      const page = (await db.query(
        `
          SELECT id
          FROM website_pages
          WHERE id = $1 AND client_id = $2 AND chatbot_id = $3
          LIMIT 1
        `,
        [pageId, account.client.id, account.chatbot.id]
      )).rows[0];

      if (!page) return null;

      await db.query(
        "DELETE FROM document_chunks WHERE client_id = $1 AND chatbot_id = $2 AND metadata->>'website_page_id' = $3",
        [account.client.id, account.chatbot.id, page.id]
      );
      await db.query(
        "DELETE FROM website_pages WHERE id = $1 AND client_id = $2 AND chatbot_id = $3",
        [page.id, account.client.id, account.chatbot.id]
      );

      return page;
    });

    if (!deleted) {
      return res.status(404).json({ error: "Website page not found." });
    }

    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

async function limitUrlsByWebsitePageEntitlement({ account, entitlement, urls }) {
  const uniqueUrls = Array.from(new Set(urls));
  if (!uniqueUrls.length) {
    throw Object.assign(new Error("Select at least one website page to add."), { statusCode: 400 });
  }

  const existingRows = (await query(
    `
      SELECT url
      FROM website_pages
      WHERE client_id = $1
        AND chatbot_id = $2
        AND status = 'indexed'
    `,
    [account.client.id, account.chatbot.id]
  )).rows;
  const existingUrls = new Set(existingRows.map((row) => row.url));
  const newUrls = uniqueUrls.filter((url) => !existingUrls.has(url));
  const availableSlots = Math.max(0, Number(entitlement.websitePageLimit || 0) - existingUrls.size);

  if (newUrls.length > availableSlots) {
    throw Object.assign(new Error(`Pro Plan includes up to ${entitlement.websitePageLimit} website pages. Delete old pages or select fewer pages.`), {
      statusCode: 402,
      publicMessage: `Pro Plan includes up to ${entitlement.websitePageLimit} website pages. Delete old pages or select fewer pages.`
    });
  }

  return uniqueUrls;
}
