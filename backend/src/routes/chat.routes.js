import crypto from "node:crypto";
import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { assertCanUseChat } from "../services/entitlements.js";
import { notifyLeadSubmitted } from "../services/email.js";
import { createChatAnswer, createEmbedding } from "../services/openai.js";

const FALLBACK_ANSWER = "I don't have that information in the uploaded business documents.";
const FALLBACK_PUBLIC_ANSWER = FALLBACK_ANSWER;
const MIN_SIMILARITY = 0.32;

export const chatRouter = express.Router();

const chatLimiter = createChatLimiter({
  windowMs: 60 * 1000,
  visitorLimit: 20,
  clientLimit: 100
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
        userMessage: message,
        botAnswer: basicAnswer,
        tokenUsage: 0,
        matchedChunks: []
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

    const context = chunks.map((chunk, index) => `Source ${index + 1}:\n${chunk.chunk_text}`).join("\n\n");
    const answerResult = context
      ? await createChatAnswer({ question: message, context })
      : { answer: FALLBACK_ANSWER, tokenUsage: 0 };
    const fallback = !context || answerResult.answer === FALLBACK_ANSWER;
    const publicAnswer = fallback ? FALLBACK_PUBLIC_ANSWER : answerResult.answer;

    const saved = await saveChatTurn({
      clientId,
      chatbotId: chatbot.id,
      visitorId: sessionId,
      userMessage: message,
      botAnswer: publicAnswer,
      tokenUsage: answerResult.tokenUsage,
      matchedChunks: chunks
    });

    res.json({
      answer: publicAnswer,
      session_id: sessionId,
      chat_session_id: saved.sessionId,
      fallback,
      sources: chunks.map((chunk) => ({
        id: chunk.id,
        document_id: chunk.document_id,
        similarity: Number(chunk.similarity)
      }))
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
      SELECT id, document_id, chunk_text, metadata, similarity
      FROM match_document_chunks($3::vector, $1::uuid, $2::uuid, 6, $4::double precision)
    `,
    [clientId, chatbotId, vectorToSql(embedding), MIN_SIMILARITY]
  );

  return result.rows;
}

async function saveChatTurn({ clientId, chatbotId, visitorId, userMessage, botAnswer, tokenUsage, matchedChunks }) {
  return withTransaction(async (db) => {
    let session = (await db.query(
      `
        SELECT id
        FROM chat_sessions
        WHERE client_id = $1
          AND chatbot_id = $2
          AND visitor_id = $3
          AND started_at > now() - interval '24 hours'
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [clientId, chatbotId, visitorId]
    )).rows[0];

    if (!session) {
      session = (await db.query(
        `
          INSERT INTO chat_sessions (client_id, chatbot_id, visitor_id, last_message_at)
          VALUES ($1, $2, $3, now())
          RETURNING id
        `,
        [clientId, chatbotId, visitorId]
      )).rows[0];
    } else {
      await db.query(
        "UPDATE chat_sessions SET last_message_at = now() WHERE id = $1",
        [session.id]
      );
    }

    await db.query(
      `
        INSERT INTO messages (session_id, client_id, chatbot_id, sender_type, message_text, token_usage)
        VALUES ($1, $2, $3, 'user', $4, 0)
      `,
      [session.id, clientId, chatbotId, userMessage]
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
          matched_chunk_ids: matchedChunks.map((chunk) => chunk.id),
          similarities: matchedChunks.map((chunk) => Number(chunk.similarity))
        }
      ]
    );

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

    return { sessionId: session.id };
  });
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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function normalizeSessionId(value) {
  const sessionId = String(value || "").trim().slice(0, 100);
  return /^[a-z0-9:_-]{12,100}$/i.test(sessionId) ? sessionId : "";
}

function getBasicAnswer(message) {
  const normalized = normalizeText(message, 80).toLowerCase();

  if (/^(hi|hello|hey|namaste|good morning|good afternoon|good evening)\b[!. ]*$/.test(normalized)) {
    return "Hi! Ask me anything about the uploaded business documents.";
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
    return new URL(origin).origin === new URL(websiteUrl).origin;
  } catch (_error) {
    return false;
  }
}
