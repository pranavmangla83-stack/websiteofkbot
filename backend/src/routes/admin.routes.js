import express from "express";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { DOCUMENT_STATUS, processDocument } from "../services/pdf-processing.js";

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

adminRouter.post("/documents/retry-stuck", async (_req, res, next) => {
  try {
    const documents = (await query(
      `
        SELECT id, client_id
        FROM documents
        WHERE status = ANY($1)
          AND updated_at < now() - interval '15 minutes'
        ORDER BY updated_at ASC
        LIMIT 10
      `,
      [processingStatuses()]
    )).rows;

    for (const document of documents) {
      processDocument(document.id, { clientId: document.client_id }).catch((error) => {
        console.error(`Admin retry failed for stuck PDF ${document.id}:`, error);
      });
    }

    res.json({
      queued: documents.length,
      document_ids: documents.map((document) => document.id)
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/documents/:id/retry", async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: "Valid document id is required." });
    }

    const document = (await query(
      "SELECT id, client_id FROM documents WHERE id = $1 LIMIT 1",
      [req.params.id]
    )).rows[0];

    if (!document) {
      return res.status(404).json({ error: "Document not found." });
    }

    processDocument(document.id, { clientId: document.client_id }).catch((error) => {
      console.error(`Admin retry failed for PDF ${document.id}:`, error);
    });

    res.json({ queued: true, document_id: document.id });
  } catch (error) {
    next(error);
  }
});

export function requireAdmin(req, res, next) {
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

function processingStatuses() {
  return [
    DOCUMENT_STATUS.UPLOADING,
    DOCUMENT_STATUS.EXTRACTING_TEXT,
    DOCUMENT_STATUS.SCANNED_DETECTED,
    DOCUMENT_STATUS.RUNNING_OCR,
    DOCUMENT_STATUS.CREATING_CHUNKS,
    DOCUMENT_STATUS.SAVING_KNOWLEDGE_BASE
  ];
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}
