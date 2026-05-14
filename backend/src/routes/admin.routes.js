import express from "express";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

export const adminRouter = express.Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/overview", async (_req, res, next) => {
  try {
    const [
      summary,
      users,
      subscriptions,
      documents,
      usage,
      leads
    ] = await Promise.all([
      query(`
        SELECT
          (SELECT count(*)::int FROM clients) AS users,
          (SELECT count(*)::int FROM subscriptions WHERE status = 'active') AS active_subscriptions,
          (SELECT count(*)::int FROM documents) AS documents,
          (SELECT count(*)::int FROM documents WHERE status = 'failed') AS failed_documents,
          (SELECT count(*)::int FROM chat_leads) AS leads
      `),
      query(`
        SELECT id, email, full_name, company_name, current_plan, created_at
        FROM clients
        ORDER BY created_at DESC
        LIMIT 50
      `),
      query(`
        SELECT s.id, s.client_id, c.email, c.company_name, s.plan_name, s.status,
               s.razorpay_subscription_id, s.start_date, s.end_date, s.updated_at
        FROM subscriptions s
        JOIN clients c ON c.id = s.client_id
        ORDER BY s.updated_at DESC
        LIMIT 50
      `),
      query(`
        SELECT d.id, d.client_id, c.email, d.file_name, d.status, d.source_type,
               d.error_message, d.created_at, d.updated_at
        FROM documents d
        JOIN clients c ON c.id = d.client_id
        ORDER BY d.created_at DESC
        LIMIT 50
      `),
      query(`
        SELECT u.client_id, c.email, u.month, u.pdf_uploaded_count,
               u.chatbot_messages_count, u.token_used, u.updated_at
        FROM usage_tracking u
        JOIN clients c ON c.id = u.client_id
        ORDER BY u.month DESC, u.updated_at DESC
        LIMIT 50
      `),
      query(`
        SELECT l.id, l.client_id, c.email AS client_email, l.name, l.email,
               l.phone, l.question, l.source_url, l.created_at
        FROM chat_leads l
        JOIN clients c ON c.id = l.client_id
        ORDER BY l.created_at DESC
        LIMIT 50
      `)
    ]);

    res.json({
      summary: summary.rows[0],
      users: users.rows,
      subscriptions: subscriptions.rows,
      documents: documents.rows,
      usage: usage.rows,
      leads: leads.rows
    });
  } catch (error) {
    next(error);
  }
});

function requireAdmin(req, res, next) {
  const email = String(req.auth?.email || "").toLowerCase();

  if (!env.adminEmails.length) {
    return res.status(503).json({
      error: "Admin access is not configured. Set ADMIN_EMAILS in the backend environment."
    });
  }

  if (!email || !env.adminEmails.includes(email)) {
    return res.status(403).json({ error: "This account is not allowed to access admin operations." });
  }

  next();
}
