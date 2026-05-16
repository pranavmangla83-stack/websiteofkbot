import express from "express";
import { env, requireEnv } from "../config/env.js";
import { query, withTransaction } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { getCurrentAccount, isSubscriptionActive, syncUserAndTenant } from "../services/accounts.js";
import { getRazorpay, verifySubscriptionCheckoutSignature, verifyWebhookSignature } from "../services/razorpay.js";

export const billingRouter = express.Router();

const RAZORPAY_PAISE_PER_RUPEE = 100;
const RAZORPAY_EXPECTED_CURRENCY = "INR";

billingRouter.post("/create-subscription", requireAuth, async (req, res, next) => {
  try {
    requireEnv(["razorpayKeyId", "razorpayKeySecret", "razorpayWebhookSecret", "razorpayBasicPlanId"]);

    const account = await syncUserAndTenant(req.auth);
    if (isSubscriptionActive(account.subscription)) {
      return res.status(409).json({ error: "Basic subscription is already active." });
    }

    const plan = (await query(
      "SELECT * FROM plans WHERE name = $1 AND is_active = true LIMIT 1",
      ["basic"]
    )).rows[0];

    if (!plan) {
      return res.status(500).json({ error: "Basic plan is not seeded in the database" });
    }

    await assertRazorpayPlanMatchesLocalPlan(plan);

    if (isAwaitingWebhookActivation(account.subscription)) {
      return res.status(409).json({
        error: "Payment is verified. Your Basic plan is being activated. Please refresh in a minute."
      });
    }

    if (await isReusableCheckoutSubscription(account.subscription)) {
      return res.json(subscriptionCheckoutResponse({
        account,
        plan,
        subscriptionId: account.subscription.razorpay_subscription_id,
        subscriptionStatus: account.subscription.status
      }));
    }

    const subscription = await getRazorpay().subscriptions.create({
      plan_id: env.razorpayBasicPlanId,
      total_count: 120,
      quantity: 1,
      customer_notify: 1,
      notes: {
        client_id: account.client.id,
        local_plan_id: plan.id,
        plan_name: plan.display_name
      }
    });

    await query(
      `
        INSERT INTO subscriptions (
          client_id,
          plan_name,
          razorpay_subscription_id,
          status
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (razorpay_subscription_id)
        DO UPDATE SET status = EXCLUDED.status, updated_at = now()
      `,
      [account.client.id, plan.display_name, subscription.id, subscription.status || "created"]
    );

    res.status(201).json(subscriptionCheckoutResponse({
      account,
      plan,
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status
    }));
  } catch (error) {
    next(error);
  }
});

billingRouter.post("/verify-checkout", requireAuth, async (req, res, next) => {
  try {
    requireEnv(["razorpayKeySecret"]);

    const {
      razorpay_payment_id: razorpayPaymentId,
      razorpay_subscription_id: razorpaySubscriptionId,
      razorpay_signature: razorpaySignature
    } = req.body || {};

    let isValid = verifySubscriptionCheckoutSignature({
      razorpayPaymentId,
      razorpaySubscriptionId,
      razorpaySignature
    });

    if (!isValid) {
      isValid = await verifyCheckoutWithRazorpayApi({
        razorpayPaymentId,
        razorpaySubscriptionId
      });
    }

    if (!isValid) {
      return res.status(400).json({
        error: "Payment could not be verified with Razorpay. Confirm the deployed Razorpay key secret matches the key id used for checkout."
      });
    }

    const account = await getCurrentAccount(req.auth);
    if (!account) {
      return res.status(404).json({ error: "User account not found" });
    }

    const subscription = (await query(
      `
        SELECT *
        FROM subscriptions
        WHERE client_id = $1
          AND razorpay_subscription_id = $2
        LIMIT 1
      `,
      [account.client.id, razorpaySubscriptionId]
    )).rows[0];

    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found for this account" });
    }

    await query(
      `
        UPDATE subscriptions
        SET status = CASE
          WHEN status = 'created' THEN 'authenticated'
          ELSE status
        END,
        updated_at = now()
        WHERE id = $1
      `,
      [subscription.id]
    );

    res.json({
      verified: true,
      subscription_id: razorpaySubscriptionId,
      payment_id: razorpayPaymentId
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.get("/status", requireAuth, async (req, res, next) => {
  try {
    const account = await getCurrentAccount(req.auth);

    if (!account) {
      return res.status(404).json({
        error: "User is not synced yet. Call POST /api/auth/sync-user after login."
      });
    }

    res.json({
      active: isSubscriptionActive(account.subscription),
      payment_state: paymentStateForSubscription(account.subscription),
      checkout_pending: isAwaitingWebhookActivation(account.subscription),
      dashboard_access_allowed: account.dashboard_access_allowed,
      plan: account.subscription ? await planForSubscription(account.subscription.plan_name) : null,
      subscription: account.subscription
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.post("/cancel-subscription", requireAuth, async (req, res, next) => {
  try {
    requireEnv(["razorpayKeyId", "razorpayKeySecret"]);

    const account = await getCurrentAccount(req.auth);
    if (!account) {
      return res.status(404).json({ error: "User account not found" });
    }

    const subscription = account.subscription;
    if (!subscription?.razorpay_subscription_id) {
      return res.status(404).json({ error: "No Razorpay subscription found for this account." });
    }

    if (paymentStateForSubscription(subscription) === "cancelled") {
      return res.status(409).json({ error: "Subscription is already cancelled." });
    }

    const razorpaySubscription = await getRazorpay().subscriptions.cancel(
      subscription.razorpay_subscription_id,
      true
    );

    const razorpayStatus = String(razorpaySubscription.status || subscription.status || "").toLowerCase();
    const localStatus = ["active", "authenticated"].includes(razorpayStatus)
      ? "cancel_requested"
      : razorpayStatus || subscription.status;

    await query(
      `
        UPDATE subscriptions
        SET status = $2,
            end_date = CASE WHEN $3::bigint IS NULL THEN end_date ELSE to_timestamp($3) END,
            updated_at = now()
        WHERE id = $1
      `,
      [
        subscription.id,
        localStatus,
        razorpaySubscription.current_end || razorpaySubscription.ended_at || null
      ]
    );

    res.json({
      cancelled: true,
      cancel_at_cycle_end: true,
      subscription_status: razorpaySubscription.status,
      current_end: razorpaySubscription.current_end || null
    });
  } catch (error) {
    next(error);
  }
});

export async function handleRazorpayWebhook(req, res, next) {
  try {
    const signature = req.get("x-razorpay-signature");
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ error: "Invalid Razorpay webhook signature" });
    }

    await processRazorpayEvent(JSON.parse(rawBody.toString("utf8")));
    res.json({ received: true });
  } catch (error) {
    next(error);
  }
}

async function processRazorpayEvent(event) {
  const eventType = event.event;
  const subscriptionEntity = event.payload?.subscription?.entity;
  const paymentEntity = event.payload?.payment?.entity;
  const razorpaySubscriptionId = subscriptionEntity?.id || paymentEntity?.subscription_id;

  await withTransaction(async (client) => {
    let subscription = null;

    if (razorpaySubscriptionId) {
      subscription = (await client.query(
        "SELECT * FROM subscriptions WHERE razorpay_subscription_id = $1 LIMIT 1",
        [razorpaySubscriptionId]
      )).rows[0] || null;
    }

    if (subscriptionEntity && subscription) {
      await client.query(
        `
          UPDATE subscriptions
          SET
            razorpay_customer_id = COALESCE($2, razorpay_customer_id),
            status = CASE
              WHEN status = 'cancel_requested' AND lower($3) IN ('active', 'authenticated') THEN status
              ELSE $3
            END,
            start_date = CASE WHEN $4::bigint IS NULL THEN start_date ELSE to_timestamp($4) END,
            end_date = CASE WHEN $5::bigint IS NULL THEN end_date ELSE to_timestamp($5) END,
            updated_at = now()
          WHERE id = $1
        `,
        [
          subscription.id,
          subscriptionEntity.customer_id || null,
          subscriptionEntity.status || eventType,
          subscriptionEntity.current_start || null,
          subscriptionEntity.current_end || null
        ]
      );
    }

    if (paymentEntity && subscription) {
      await client.query(
        `
          INSERT INTO payments (
            client_id,
            razorpay_payment_id,
            razorpay_subscription_id,
            amount,
            currency,
            status,
            raw_payload_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (razorpay_payment_id) DO UPDATE SET
            status = EXCLUDED.status,
            raw_payload_json = EXCLUDED.raw_payload_json
        `,
        [
          subscription.client_id,
          paymentEntity.id,
          razorpaySubscriptionId,
          paymentEntity.amount,
          paymentEntity.currency || "INR",
          paymentEntity.status || eventType,
          event
        ]
      );
    }

    const statusFromEvent = statusForEvent(eventType);
    if (subscription && statusFromEvent) {
      await client.query(
        `
          UPDATE subscriptions
          SET status = CASE
              WHEN status = 'cancel_requested' AND $2 = 'active' THEN status
              ELSE $2
            END,
            updated_at = now()
          WHERE id = $1
        `,
        [subscription.id, statusFromEvent]
      );

      if (statusFromEvent === "active") {
        await client.query(
          "UPDATE clients SET current_plan = $2, updated_at = now() WHERE id = $1",
          [subscription.client_id, String(subscription.plan_name || "Basic").toLowerCase()]
        );
      } else if (removesPaidEntitlement(statusFromEvent)) {
        await client.query(
          "UPDATE clients SET current_plan = 'free', updated_at = now() WHERE id = $1",
          [subscription.client_id]
        );
      }
    }
  });
}

async function planForSubscription(planName) {
  const normalized = String(planName || "").toLowerCase();
  const plan = (await query(
    "SELECT * FROM plans WHERE lower(display_name) = $1 OR lower(name) = $1 LIMIT 1",
    [normalized]
  )).rows[0];

  if (!plan) return { name: planName };

  return {
    name: plan.display_name,
    price_inr: plan.price_inr,
    billing_interval: plan.billing_interval
  };
}

function statusForEvent(eventType) {
  const statuses = {
    "subscription.activated": "active",
    "subscription.charged": "active",
    "subscription.completed": "cancelled",
    "subscription.cancelled": "cancelled",
    "subscription.halted": "payment_failed",
    "subscription.paused": "payment_failed",
    "subscription.resumed": "active",
    "payment.failed": "payment_failed"
  };

  return statuses[eventType] || null;
}

function paymentStateForSubscription(subscription) {
  if (!subscription) return "trial";

  const status = String(subscription.status || "").toLowerCase();
  if (status === "active") return "active";
  if (status === "cancel_requested") return "cancel_requested";
  if (["payment_failed", "past_due", "halted", "paused"].includes(status)) return "payment_failed";
  if (["cancelled", "canceled", "completed", "expired"].includes(status)) return "cancelled";

  return "trial";
}

async function isReusableCheckoutSubscription(subscription) {
  if (!subscription?.razorpay_subscription_id) return false;
  if (String(subscription.status || "").toLowerCase() !== "created") return false;

  const razorpaySubscription = await getRazorpay().subscriptions.fetch(subscription.razorpay_subscription_id);
  return razorpaySubscription.plan_id === env.razorpayBasicPlanId
    && String(razorpaySubscription.status || "").toLowerCase() === "created";
}

function isAwaitingWebhookActivation(subscription) {
  if (!subscription) return false;
  return String(subscription.status || "").toLowerCase() === "authenticated";
}

function subscriptionCheckoutResponse({ account, plan, subscriptionId, subscriptionStatus }) {
  return {
    razorpay_key_id: env.razorpayKeyId,
    subscription_id: subscriptionId,
    subscription_status: subscriptionStatus,
    plan: {
      id: plan.id,
      name: plan.display_name,
      price_inr: plan.price_inr,
      billing_interval: plan.billing_interval
    },
    checkout: {
      key: env.razorpayKeyId,
      subscription_id: subscriptionId,
      name: "Custom AI Chatbot",
      description: "Basic monthly plan",
      prefill: {
        email: account.user.email || ""
      }
    }
  };
}

async function verifyCheckoutWithRazorpayApi({ razorpayPaymentId, razorpaySubscriptionId }) {
  if (!razorpayPaymentId || !razorpaySubscriptionId) return false;

  const [payment, subscription] = await Promise.all([
    getRazorpay().payments.fetch(razorpayPaymentId),
    getRazorpay().subscriptions.fetch(razorpaySubscriptionId)
  ]);

  return payment?.subscription_id === razorpaySubscriptionId
    && subscription?.id === razorpaySubscriptionId
    && subscription?.plan_id === env.razorpayBasicPlanId
    && ["authorized", "captured"].includes(String(payment?.status || "").toLowerCase());
}

async function assertRazorpayPlanMatchesLocalPlan(plan) {
  const razorpayPlan = await getRazorpay().plans.fetch(env.razorpayBasicPlanId);
  const expectedAmount = Number(plan.price_inr) * RAZORPAY_PAISE_PER_RUPEE;
  const actualAmount = Number(razorpayPlan.item?.amount);
  const actualCurrency = String(razorpayPlan.item?.currency || "").toUpperCase();
  const expectedPeriod = String(plan.billing_interval || "").toLowerCase() === "yearly" ? "yearly" : "monthly";
  const actualPeriod = String(razorpayPlan.period || "").toLowerCase();
  const actualInterval = Number(razorpayPlan.interval || 0);

  if (
    actualAmount !== expectedAmount
    || actualCurrency !== RAZORPAY_EXPECTED_CURRENCY
    || actualPeriod !== expectedPeriod
    || actualInterval !== 1
  ) {
    throw new Error(
      `Razorpay Basic plan mismatch. Expected ${RAZORPAY_EXPECTED_CURRENCY} ${plan.price_inr}/${expectedPeriod}; ` +
      `configured plan is ${actualCurrency || "UNKNOWN"} ${Number.isFinite(actualAmount) ? actualAmount / RAZORPAY_PAISE_PER_RUPEE : "UNKNOWN"}/${actualPeriod || "UNKNOWN"}.`
    );
  }
}

function removesPaidEntitlement(status) {
  return ["payment_failed", "cancelled"].includes(status);
}
