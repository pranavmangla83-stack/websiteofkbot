import { withTransaction } from "../db/pool.js";

export async function syncUserAndTenant(auth) {
  return withTransaction(async (db) => {
    const clientResult = await db.query(
      `
        INSERT INTO clients (kinde_user_id, email, full_name, company_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (kinde_user_id)
        DO UPDATE SET
          email = COALESCE(EXCLUDED.email, clients.email),
          full_name = COALESCE(EXCLUDED.full_name, clients.full_name),
          company_name = COALESCE(clients.company_name, EXCLUDED.company_name),
          updated_at = now()
        RETURNING *
      `,
      [auth.kindeUserId, auth.email, auth.name, defaultCompanyName(auth)]
    );

    const clientAccount = clientResult.rows[0];

    await db.query(
      `
        INSERT INTO users (client_id, kinde_user_id, email, full_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (kinde_user_id)
        DO UPDATE SET
          client_id = EXCLUDED.client_id,
          email = COALESCE(EXCLUDED.email, users.email),
          full_name = COALESCE(EXCLUDED.full_name, users.full_name),
          updated_at = now()
      `,
      [clientAccount.id, auth.kindeUserId, auth.email, auth.name]
    );

    const chatbot = await ensureDefaultChatbot(db, clientAccount);
    const subscription = await getClientSubscription(db, clientAccount.id);

    return shapeAccountResponse({
      client: clientAccount,
      chatbot,
      subscription
    });
  });
}

export async function getCurrentAccount(auth) {
  return withTransaction(async (db) => {
    const clientAccount = (await db.query(
      "SELECT * FROM clients WHERE kinde_user_id = $1",
      [auth.kindeUserId]
    )).rows[0];

    if (!clientAccount) return null;

    const chatbot = (await db.query(
      "SELECT * FROM chatbots WHERE client_id = $1 ORDER BY created_at ASC LIMIT 1",
      [clientAccount.id]
    )).rows[0] || null;
    const subscription = await getClientSubscription(db, clientAccount.id);

    return shapeAccountResponse({
      client: clientAccount,
      chatbot,
      subscription
    });
  });
}

export async function getClientSubscription(db, clientId) {
  const result = await db.query(
    `
      SELECT *
      FROM subscriptions
      WHERE client_id = $1
      ORDER BY
        CASE
          WHEN lower(status) IN ('active', 'cancel_requested') THEN 0
          WHEN lower(status) = 'authenticated' THEN 1
          WHEN lower(status) = 'created' THEN 2
          ELSE 3
        END,
        CASE WHEN lower(plan_name) LIKE '%pro%' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `,
    [clientId]
  );

  return result.rows[0] || null;
}

export function isSubscriptionActive(subscription) {
  const status = String(subscription?.status || "").toLowerCase();
  return ["active", "cancel_requested"].includes(status);
}

async function ensureDefaultChatbot(db, clientAccount) {
  const existing = (await db.query(
    "SELECT * FROM chatbots WHERE client_id = $1 ORDER BY created_at ASC LIMIT 1",
    [clientAccount.id]
  )).rows[0];

  if (existing) return existing;

  const inserted = await db.query(
    `
      INSERT INTO chatbots (client_id, chatbot_name)
      VALUES ($1, $2)
      RETURNING *
    `,
    [clientAccount.id, "AI Assistant"]
  );

  return inserted.rows[0];
}

function shapeAccountResponse({ client, chatbot, subscription }) {
  return {
    client,
    chatbot,
    subscription,
    dashboard_access_allowed: isSubscriptionActive(subscription),
    tenant: {
      id: client.id,
      tenant_key: client.id,
      company_name: client.company_name,
      website_url: chatbot?.website_url || null,
      created_at: client.created_at,
      updated_at: client.updated_at
    },
    user: {
      id: client.id,
      kinde_user_id: client.kinde_user_id,
      email: client.email,
      name: client.full_name,
      created_at: client.created_at,
      updated_at: client.updated_at
    },
    chatbot_settings: chatbot ? {
      id: chatbot.id,
      tenant_id: client.id,
      bot_name: chatbot.chatbot_name,
      public_embed_key: chatbot.public_embed_key,
      website_url: chatbot.website_url,
      theme_settings: chatbot.theme_settings,
      embed_script: chatbot.embed_script,
      created_at: chatbot.created_at,
      updated_at: chatbot.updated_at
    } : null
  };
}

function defaultCompanyName(auth) {
  if (auth.name) return auth.name;
  if (auth.email) return auth.email.split("@")[0];
  return "My Company";
}
