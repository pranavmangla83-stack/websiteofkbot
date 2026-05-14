import express from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { getCurrentAccount, syncUserAndTenant } from "../services/accounts.js";

export const meRouter = express.Router();

meRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const account = await getCurrentAccount(req.auth);

    if (!account) {
      return res.status(404).json({
        error: "User is not synced yet. Call POST /api/auth/sync-user after login."
      });
    }

    res.json(account);
  } catch (error) {
    next(error);
  }
});

meRouter.patch("/chatbot-settings", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const websiteUrl = normalizeWebsiteUrl(req.body?.website_url);

    await query(
      `
        UPDATE chatbots
        SET website_url = $2,
            updated_at = now()
        WHERE id = $1
          AND client_id = $3
      `,
      [account.chatbot.id, websiteUrl, account.client.id]
    );

    const updated = await getCurrentAccount(req.auth);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

function normalizeWebsiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw Object.assign(new Error("Website URL must be a valid http or https URL."), { statusCode: 400 });
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Website URL must use http or https."), { statusCode: 400 });
  }

  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}
