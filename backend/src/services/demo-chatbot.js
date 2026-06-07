import { query, withTransaction } from "../db/pool.js";
import { createEmbedding } from "./openai.js";
import { preparePdfForKnowledgeBase } from "./pdf-processing.js";
import { discoverWebsitePages, indexWebsitePages, normalizePublicUrl } from "./website-processing.js";

export const DEMO_CLIENT_KINDE_ID = "homepage-demo";
export const DEMO_MESSAGE_LIMIT = 5;
export const DEMO_DATA_TTL_HOURS = 72;
export const DEMO_MAX_PAGES = 3;
export const DEMO_MAX_PDF_BYTES = 10 * 1024 * 1024;
export const DEMO_MAX_PDF_CHUNKS = 40;

const DEMO_CRAWL_OPTIONS = {
  maxPages: DEMO_MAX_PAGES,
  maxDepth: 1,
  fetchTimeoutMs: 10_000
};

export async function crawlDemoWebsite({ visitorId, websiteUrl, visitorMetadata }) {
  await cleanupExpiredDemoData();

  const normalizedUrl = normalizePublicUrl(websiteUrl);
  const allowedHostname = normalizedUrl.hostname.toLowerCase();
  const options = {
    ...DEMO_CRAWL_OPTIONS,
    allowedHostname
  };
  const client = await ensureDemoClient();
  const chatbot = await ensureSessionDemoChatbot({
    clientId: client.id,
    visitorId,
    websiteUrl: normalizedUrl.href
  });

  const session = await getOrCreateDemoSession({
    clientId: client.id,
    chatbotId: chatbot.id,
    visitorId,
    visitorMetadata: {
      ...(visitorMetadata || {}),
      website_url: normalizedUrl.href,
      source: "demo_chat",
      demo: true
    }
  });

  const pages = await discoverWebsitePages(normalizedUrl.href, options);
  const urls = pages.map((page) => page.url).slice(0, DEMO_MAX_PAGES);
  const result = await indexWebsitePages({
    account: { client, chatbot },
    urls,
    options
  });

  if (!result.indexed.length) {
    throw Object.assign(new Error("Could not read enough public text from this website."), {
      statusCode: 400,
      publicMessage: "Could not read enough public text from this website."
    });
  }

  return {
    client,
    chatbot,
    session,
    website_url: normalizedUrl.href,
    hostname: allowedHostname,
    max_pages: DEMO_MAX_PAGES,
    max_depth: DEMO_CRAWL_OPTIONS.maxDepth,
    timeout_ms: DEMO_CRAWL_OPTIONS.fetchTimeoutMs,
    indexed_pages: result.indexed.length,
    failed_pages: result.failed.length,
    indexed: result.indexed,
    failed: result.failed
  };
}

export async function indexDemoPdf({ visitorId, pdfBuffer, fileName, visitorMetadata }) {
  await cleanupExpiredDemoData();

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw Object.assign(new Error("PDF file is required."), { statusCode: 400 });
  }

  if (pdfBuffer.length > DEMO_MAX_PDF_BYTES) {
    throw Object.assign(new Error("In demo, you can upload one PDF of 10 MB only."), {
      statusCode: 400,
      publicMessage: "In demo, you can upload one PDF of 10 MB only."
    });
  }

  const client = await ensureDemoClient();
  const chatbot = await ensureSessionDemoChatbot({
    clientId: client.id,
    visitorId
  });

  const session = await getOrCreateDemoSession({
    clientId: client.id,
    chatbotId: chatbot.id,
    visitorId,
    visitorMetadata: {
      ...(visitorMetadata || {}),
      source: "demo_chat",
      demo: true,
      demo_pdf_file_name: fileName || "demo.pdf"
    }
  });

  const processed = await preparePdfForKnowledgeBase({ pdfBuffer });
  const limitedChunks = processed.chunks.slice(0, DEMO_MAX_PDF_CHUNKS);
  const embeddedChunks = [];

  for (let index = 0; index < limitedChunks.length; index += 1) {
    const chunk = limitedChunks[index];
    embeddedChunks.push({
      index,
      chunkText: chunk.chunkText,
      embedding: await createEmbedding(chunk.chunkText),
      tokenCount: Math.ceil(chunk.chunkText.length / 4),
      pageNumber: chunk.pageNumber,
      sourceType: chunk.sourceType,
      ocrConfidence: chunk.ocrConfidence
    });
  }

  await withTransaction(async (db) => {
    await db.query(
      `
        DELETE FROM document_chunks
        WHERE client_id = $1
          AND chatbot_id = $2
          AND source_type IN ('pdf_text', 'ocr')
          AND metadata->>'demo_pdf' = 'true'
      `,
      [client.id, chatbot.id]
    );

    for (const chunk of embeddedChunks) {
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
          VALUES (NULL, $1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10, $11)
        `,
        [
          client.id,
          client.id,
          chatbot.id,
          chunk.index,
          chunk.chunkText,
          vectorToSql(chunk.embedding),
          chunk.tokenCount,
          chunk.pageNumber,
          chunk.sourceType,
          chunk.ocrConfidence,
          {
            demo_pdf: true,
            file_name: fileName || "demo.pdf",
            chunk_index: chunk.index,
            total_chunks: embeddedChunks.length,
            total_extracted_chunks: processed.chunks.length,
            page_number: chunk.pageNumber,
            source_type: chunk.sourceType,
            ocr_confidence: chunk.ocrConfidence
          }
        ]
      );
    }
  });

  return {
    client,
    chatbot,
    session,
    file_name: fileName || "demo.pdf",
    source_type: processed.sourceType,
    page_count: processed.pageCount || null,
    chunks_created: embeddedChunks.length,
    chunks_limited: processed.chunks.length > embeddedChunks.length,
    max_chunks: DEMO_MAX_PDF_CHUNKS
  };
}

export async function getDemoSessionChatbot(visitorId) {
  await cleanupExpiredDemoData();

  const result = await query(
    `
      SELECT
        cs.id AS session_id,
        cs.client_id,
        cs.chatbot_id,
        cb.website_url
      FROM chat_sessions cs
      JOIN clients c ON c.id = cs.client_id
      JOIN chatbots cb ON cb.id = cs.chatbot_id
      WHERE c.kinde_user_id = $1
        AND cs.session_type = 'demo'
        AND cs.visitor_id = $2
        AND cs.started_at > now() - interval '${DEMO_DATA_TTL_HOURS} hours'
      ORDER BY cs.started_at DESC
      LIMIT 1
    `,
    [DEMO_CLIENT_KINDE_ID, visitorId]
  );

  return result.rows[0] || null;
}

export async function cleanupExpiredDemoData() {
  await query(
    `
      DELETE FROM chatbots cb
      USING clients c
      WHERE cb.client_id = c.id
        AND c.kinde_user_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM chat_sessions cs
          WHERE cs.chatbot_id = cb.id
            AND cs.started_at > now() - interval '${DEMO_DATA_TTL_HOURS} hours'
        )
    `,
    [DEMO_CLIENT_KINDE_ID]
  );
}

async function ensureDemoClient() {
  const result = await query(
    `
      INSERT INTO clients (kinde_user_id, email, full_name, company_name, current_plan)
      VALUES ($1, NULL, 'Homepage Demo Visitor', 'Homepage Demo', 'demo')
      ON CONFLICT (kinde_user_id)
      DO UPDATE SET company_name = EXCLUDED.company_name
      RETURNING *
    `,
    [DEMO_CLIENT_KINDE_ID]
  );

  return result.rows[0];
}

async function ensureSessionDemoChatbot({ clientId, visitorId, websiteUrl }) {
  return withTransaction(async (db) => {
    const existing = (await db.query(
      `
        SELECT cb.*
        FROM chat_sessions cs
        JOIN chatbots cb ON cb.id = cs.chatbot_id
        WHERE cs.client_id = $1
          AND cs.visitor_id = $2
          AND cs.session_type = 'demo'
          AND cs.started_at > now() - interval '${DEMO_DATA_TTL_HOURS} hours'
        ORDER BY cs.started_at DESC
        LIMIT 1
      `,
      [clientId, visitorId]
    )).rows[0];

    if (existing) {
      const updated = (await db.query(
        `
          UPDATE chatbots
          SET website_url = COALESCE($1, website_url), updated_at = now()
          WHERE id = $2
          RETURNING *
        `,
        [websiteUrl || null, existing.id]
      )).rows[0];

      if (websiteUrl) {
        await db.query("DELETE FROM document_chunks WHERE client_id = $1 AND chatbot_id = $2 AND source_type = 'website'", [clientId, existing.id]);
        await db.query("DELETE FROM website_pages WHERE client_id = $1 AND chatbot_id = $2", [clientId, existing.id]);
      }

      return updated;
    }

    return (await db.query(
      `
        INSERT INTO chatbots (client_id, chatbot_name, website_url)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [clientId, "Homepage Demo Chatbot", websiteUrl]
    )).rows[0];
  });
}

function vectorToSql(embedding) {
  return `[${embedding.join(",")}]`;
}

async function getOrCreateDemoSession({ clientId, chatbotId, visitorId, visitorMetadata }) {
  const existing = (await query(
    `
      SELECT *
      FROM chat_sessions
      WHERE client_id = $1
        AND visitor_id = $2
        AND session_type = 'demo'
        AND started_at > now() - interval '${DEMO_DATA_TTL_HOURS} hours'
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [clientId, visitorId]
  )).rows[0];

  if (existing) {
    const updated = await query(
      `
        UPDATE chat_sessions
        SET chatbot_id = $1,
            visitor_metadata = visitor_metadata || $2::jsonb,
            last_message_at = now()
        WHERE id = $3
        RETURNING *
      `,
      [chatbotId, visitorMetadata || {}, existing.id]
    );
    return updated.rows[0];
  }

  const inserted = await query(
    `
      INSERT INTO chat_sessions (client_id, chatbot_id, session_type, visitor_id, visitor_metadata, last_message_at)
      VALUES ($1, $2, 'demo', $3, $4, now())
      RETURNING *
    `,
    [clientId, chatbotId, visitorId, visitorMetadata || {}]
  );

  return inserted.rows[0];
}
