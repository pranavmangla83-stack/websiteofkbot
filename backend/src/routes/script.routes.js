import express from "express";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { syncUserAndTenant } from "../services/accounts.js";

export const scriptRouter = express.Router();

scriptRouter.get("/get-script", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const script = `<script src="${env.backendUrl.replace(/\/$/, "")}/widget.js" data-client-id="${account.client.id}" data-chatbot-key="${account.chatbot.public_embed_key}"></script>`;

    res.json({
      client_id: account.client.id,
      chatbot_key: account.chatbot.public_embed_key,
      script
    });
  } catch (error) {
    next(error);
  }
});
