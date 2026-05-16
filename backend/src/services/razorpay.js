import crypto from "node:crypto";
import Razorpay from "razorpay";
import { env, requireEnv } from "../config/env.js";

let razorpay;

export function getRazorpay() {
  requireEnv(["razorpayKeyId", "razorpayKeySecret"]);

  if (!razorpay) {
    razorpay = new Razorpay({
      key_id: env.razorpayKeyId,
      key_secret: env.razorpayKeySecret
    });
  }

  return razorpay;
}

export function verifyWebhookSignature(rawBody, signature) {
  requireEnv(["razorpayWebhookSecret"]);

  const expectedSignature = crypto
    .createHmac("sha256", env.razorpayWebhookSecret)
    .update(rawBody)
    .digest("hex");

  const actualSignature = signature || "";
  if (actualSignature.length !== expectedSignature.length) return false;

  return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(actualSignature));
}

export function verifySubscriptionCheckoutSignature({ razorpayPaymentId, razorpaySubscriptionId, razorpaySignature }) {
  requireEnv(["razorpayKeySecret"]);

  if (!razorpayPaymentId || !razorpaySubscriptionId || !razorpaySignature) {
    return false;
  }

  return matchesSignature(razorpaySignature, `${razorpayPaymentId}|${razorpaySubscriptionId}`)
    || matchesSignature(razorpaySignature, `${razorpaySubscriptionId}|${razorpayPaymentId}`);
}

function matchesSignature(razorpaySignature, payload) {
  const expectedSignature = crypto
    .createHmac("sha256", env.razorpayKeySecret)
    .update(payload)
    .digest("hex");

  if (razorpaySignature.length !== expectedSignature.length) return false;

  return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpaySignature));
}

export function verifyOrderCheckoutSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  requireEnv(["razorpayKeySecret"]);

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", env.razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  if (razorpaySignature.length !== expectedSignature.length) return false;

  return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpaySignature));
}
