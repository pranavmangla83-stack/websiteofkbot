import { isSubscriptionActive } from "./accounts.js";
import { PLAN_LIMITS, planKeyForName } from "../config/plans.js";

const TRIAL_MESSAGE_LIMIT = 50;
const TRIAL_TOKEN_LIMIT = 100000;

export async function assertCanUploadPdf(db, account) {
  const entitlement = await getClientEntitlement(db, account);
  const uploadedCount = Number((await db.query(
    `
      SELECT count(*)::int AS count
      FROM documents
      WHERE client_id = $1
        AND status <> 'failed'
    `,
    [account.client.id]
  )).rows[0]?.count || 0);

  if (uploadedCount >= entitlement.pdfLimit) {
    throw entitlementError(
      entitlement.active
        ? `PDF upload limit reached for your ${entitlement.planName} plan.`
        : "Basic is required before uploading more PDFs."
    );
  }

  return { entitlement, uploadedCount };
}

export async function assertCanUseWebsiteCrawling(db, account) {
  const entitlement = await getClientEntitlement(db, account);

  if (!entitlement.websiteCrawling) {
    throw entitlementError("Website crawling is available in Pro Plan.");
  }

  return { entitlement };
}

export async function assertCanUseChat(db, clientId) {
  const account = await getPublicClientAccount(db, clientId);
  if (!account) {
    throw Object.assign(new Error("Client not found."), { statusCode: 404 });
  }

  const entitlement = await getClientEntitlement(db, account);
  const usage = await getCurrentMonthUsage(db, clientId);

  if (usage.messages >= entitlement.messageLimit) {
    throw entitlementError(
      entitlement.active
        ? `Monthly message limit reached for your ${entitlement.planName} plan.`
        : "Basic is required to continue using chat."
    );
  }

  if (usage.tokens >= entitlement.tokenLimit) {
    throw entitlementError(
      entitlement.active
        ? `Monthly token limit reached for your ${entitlement.planName} plan.`
        : "Basic is required to continue using chat."
    );
  }

  return { entitlement, usage };
}

export async function getClientEntitlement(db, account) {
  const active = isSubscriptionActive(account.subscription);
  if (active) {
    const plan = await getPlanByName(db, account.subscription.plan_name);
    if (plan) {
      const limits = PLAN_LIMITS[planKeyForName(plan.name || plan.display_name)];
      return {
        active: true,
        planName: plan.display_name,
        websiteCrawling: limits.websiteCrawling,
        websitePageLimit: limits.maxWebsitePages,
        pdfLimit: limits.maxPdfs,
        maxPdfSizeMb: limits.maxPdfSizeMb,
        maxPdfBytes: limits.maxPdfSizeMb * 1024 * 1024,
        messageLimit: limits.monthlyReplies,
        tokenLimit: Number(plan.token_limit),
        price: limits.price
      };
    }
  }

  const basicLimits = PLAN_LIMITS.basic;
  return {
    active: false,
    planName: "Basic inactive",
    websiteCrawling: false,
    websitePageLimit: basicLimits.maxWebsitePages,
    pdfLimit: Number(account.client.pdf_limit || basicLimits.maxPdfs),
    maxPdfSizeMb: basicLimits.maxPdfSizeMb,
    maxPdfBytes: basicLimits.maxPdfSizeMb * 1024 * 1024,
    messageLimit: TRIAL_MESSAGE_LIMIT,
    tokenLimit: TRIAL_TOKEN_LIMIT,
    price: basicLimits.price
  };
}

async function getPublicClientAccount(db, clientId) {
  const client = (await db.query(
    "SELECT * FROM clients WHERE id = $1 LIMIT 1",
    [clientId]
  )).rows[0];

  if (!client) return null;

  const subscription = (await db.query(
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
  )).rows[0] || null;

  return { client, subscription };
}

async function getPlanByName(db, planName) {
  const normalized = String(planName || "").toLowerCase();
  if (!normalized) return null;

  return (await db.query(
    `
      SELECT *
      FROM plans
      WHERE lower(name) = $1
         OR lower(display_name) = $1
      LIMIT 1
    `,
    [normalized]
  )).rows[0] || null;
}

async function getCurrentMonthUsage(db, clientId) {
  const month = new Date();
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);

  const usage = (await db.query(
    `
      SELECT chatbot_messages_count, token_used
      FROM usage_tracking
      WHERE client_id = $1
        AND month = $2
      LIMIT 1
    `,
    [clientId, month.toISOString().slice(0, 10)]
  )).rows[0];

  return {
    messages: Number(usage?.chatbot_messages_count || 0),
    tokens: Number(usage?.token_used || 0)
  };
}

function entitlementError(message) {
  return Object.assign(new Error(message), {
    statusCode: 402,
    publicMessage: message
  });
}
