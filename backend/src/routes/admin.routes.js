import express from "express";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { DOCUMENT_STATUS } from "../services/pdf-metadata.js";

export const adminRouter = express.Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/overview", async (req, res, next) => {
  try {
    const chatType = normalizeChatType(req.query?.chat_type);
    const timeRange = normalizeTimeRange(req.query?.time_range);
    const timeClause = chatTimeClause(timeRange);
    const demoWhere = chatType === "customer" ? "false" : `cs.session_type = 'demo'${timeClause}`;
    const customerWhere = chatType === "demo" ? "false" : `cs.session_type = 'customer'${timeClause}`;
    const [
      summary,
      users,
      subscriptions,
      documents,
      usage,
      leads,
      demoWebsitePages,
      customerWebsitePages,
      demoChats,
      customerChats
    ] = await Promise.all([
      query(`
        SELECT
          (SELECT count(*)::int FROM clients) AS users,
          (SELECT count(*)::int FROM subscriptions WHERE status = 'active') AS active_subscriptions,
          (SELECT count(*)::int FROM documents) AS documents,
          (SELECT count(*)::int FROM documents WHERE status = 'failed') AS failed_documents,
          (SELECT count(*)::int FROM chat_leads) AS leads,
          (
            SELECT count(*)::int
            FROM chat_sessions cs
            WHERE cs.session_type = 'demo'
          ) AS demo_chat_sessions,
          (
            SELECT count(*)::int
            FROM messages m
            JOIN chat_sessions cs ON cs.id = m.session_id
            WHERE cs.session_type = 'demo'
          ) AS demo_chat_messages,
          (
            SELECT count(*)::int
            FROM chat_sessions cs
            WHERE cs.session_type = 'customer'
          ) AS customer_chat_sessions,
          (
            SELECT count(*)::int
            FROM messages m
            JOIN chat_sessions cs ON cs.id = m.session_id
            WHERE cs.session_type = 'customer'
          ) AS customer_chat_messages
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
      `),
      query(`
        SELECT wp.id, wp.client_id, wp.chatbot_id, wp.url, wp.title, wp.status,
               wp.error_message, wp.indexed_at, wp.updated_at
        FROM website_pages wp
        JOIN clients c ON c.id = wp.client_id
        WHERE c.kinde_user_id = 'homepage-demo'
        ORDER BY wp.updated_at DESC
        LIMIT 50
      `),
      query(`
        SELECT wp.id, wp.client_id, wp.chatbot_id, c.email AS client_email,
               wp.url, wp.title, wp.status, wp.error_message, wp.indexed_at, wp.updated_at
        FROM website_pages wp
        JOIN clients c ON c.id = wp.client_id
        WHERE c.kinde_user_id <> 'homepage-demo'
        ORDER BY wp.updated_at DESC
        LIMIT 50
      `),
      query(`
        SELECT
          cs.id,
          cs.client_id,
          cs.chatbot_id,
          cs.session_type,
          cb.website_url,
          cs.visitor_id,
          cs.visitor_metadata,
          cs.started_at,
          cs.last_message_at,
          count(m.id)::int AS message_count,
          (
            SELECT um.message_text
            FROM messages um
            WHERE um.session_id = cs.id AND um.sender_type = 'user'
            ORDER BY um.created_at DESC
            LIMIT 1
          ) AS last_user_message,
          COALESCE(
            json_agg(
              json_build_object(
                'sender', m.sender_type,
                'message', m.message_text,
                'created_at', m.created_at
              )
              ORDER BY m.created_at ASC
            ) FILTER (WHERE m.id IS NOT NULL),
            '[]'::json
          ) AS transcript
        FROM chat_sessions cs
        JOIN chatbots cb ON cb.id = cs.chatbot_id
        LEFT JOIN messages m ON m.session_id = cs.id
        WHERE ${demoWhere}
        GROUP BY cs.id, cb.website_url
        ORDER BY cs.last_message_at DESC NULLS LAST, cs.started_at DESC
        LIMIT 50
      `),
      query(`
        SELECT
          cs.id,
          cs.client_id,
          cs.chatbot_id,
          cs.session_type,
          c.email AS client_email,
          c.company_name,
          cb.website_url,
          cs.visitor_id,
          cs.visitor_metadata,
          cs.started_at,
          cs.last_message_at,
          count(m.id)::int AS message_count,
          (
            SELECT um.message_text
            FROM messages um
            WHERE um.session_id = cs.id AND um.sender_type = 'user'
            ORDER BY um.created_at DESC
            LIMIT 1
          ) AS last_user_message,
          COALESCE(
            json_agg(
              json_build_object(
                'sender', m.sender_type,
                'message', m.message_text,
                'created_at', m.created_at
              )
              ORDER BY m.created_at ASC
            ) FILTER (WHERE m.id IS NOT NULL),
            '[]'::json
          ) AS transcript
        FROM chat_sessions cs
        JOIN chatbots cb ON cb.id = cs.chatbot_id
        JOIN clients c ON c.id = cs.client_id
        LEFT JOIN messages m ON m.session_id = cs.id
        WHERE ${customerWhere}
        GROUP BY cs.id, c.email, c.company_name, cb.website_url
        ORDER BY cs.last_message_at DESC NULLS LAST, cs.started_at DESC
        LIMIT 50
      `)
    ]);

    res.json({
      summary: summary.rows[0],
      users: users.rows,
      subscriptions: subscriptions.rows,
      documents: documents.rows,
      usage: usage.rows,
      leads: leads.rows,
      demo_website_pages: demoWebsitePages.rows,
      customer_website_pages: customerWebsitePages.rows,
      demo_chat_sessions: demoChats.rows,
      customer_chat_sessions: customerChats.rows,
      chat_filters: {
        chat_type: chatType,
        time_range: timeRange
      }
    });
  } catch (error) {
    next(error);
  }
});

function normalizeChatType(value) {
  return ["all", "demo", "customer"].includes(String(value || "")) ? String(value) : "all";
}

function normalizeTimeRange(value) {
  return ["all", "24h", "7d"].includes(String(value || "")) ? String(value) : "all";
}

function chatTimeClause(timeRange) {
  if (timeRange === "24h") return " AND cs.started_at >= now() - interval '24 hours'";
  if (timeRange === "7d") return " AND cs.started_at >= now() - interval '7 days'";
  return "";
}

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

export async function requireAdmin(req, res, next) {
  try {
    const adminEmails = new Set(env.adminEmails);
    const candidateEmails = new Set(
      [req.auth?.email, ...(await getStoredAccountEmails(req.auth?.kindeUserId))]
        .map((email) => String(email || "").trim().toLowerCase())
        .filter(Boolean)
    );

    if (!adminEmails.size) {
      return res.status(503).json({
        error: "Admin access is not configured. Set ADMIN_EMAILS in the backend environment."
      });
    }

    const isAllowed = [...candidateEmails].some((email) => adminEmails.has(email));
    if (!isAllowed) {
      return res.status(403).json({ error: "This account is not allowed to access admin operations." });
    }

    next();
  } catch (error) {
    next(error);
  }
}

async function getStoredAccountEmails(kindeUserId) {
  if (!kindeUserId) return [];

  const result = await query(
    `
      SELECT email
      FROM clients
      WHERE kinde_user_id = $1
      UNION
      SELECT email
      FROM users
      WHERE kinde_user_id = $1
    `,
    [kindeUserId]
  );

  return result.rows.map((row) => row.email);
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

async function processDocument(documentId, options) {
  const { processDocument: runProcessDocument } = await import("../services/pdf-processing.js");
  return runProcessDocument(documentId, options);
}
