import { query, withTransaction } from "../db/pool.js";
import { discoverWebsitePages, indexWebsitePages, normalizePublicUrl } from "./website-processing.js";

export const DEMO_CLIENT_KINDE_ID = "homepage-demo";
export const DEMO_MESSAGE_LIMIT = 5;
export const DEMO_DATA_TTL_HOURS = 72;
export const DEMO_MAX_PAGES = 3;

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
          SET website_url = $1, updated_at = now()
          WHERE id = $2
          RETURNING *
        `,
        [websiteUrl, existing.id]
      )).rows[0];

      await db.query("DELETE FROM document_chunks WHERE client_id = $1 AND chatbot_id = $2", [clientId, existing.id]);
      await db.query("DELETE FROM website_pages WHERE client_id = $1 AND chatbot_id = $2", [clientId, existing.id]);

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
