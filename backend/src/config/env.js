import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  backendUrl: process.env.BACKEND_URL || "http://localhost:4000",
  kindeIssuerUrl: process.env.KINDE_ISSUER_URL,
  kindeAudience: process.env.KINDE_AUDIENCE,
  kindeClientId: process.env.KINDE_CLIENT_ID,
  kindeClientSecret: process.env.KINDE_CLIENT_SECRET,
  razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  razorpayBasicPlanId: process.env.RAZORPAY_BASIC_PLAN_ID,
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
};

const envKeyNames = {
  port: "PORT",
  host: "HOST",
  databaseUrl: "DATABASE_URL",
  supabaseUrl: "SUPABASE_URL",
  supabaseAnonKey: "SUPABASE_ANON_KEY",
  supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
  supabaseSecretKey: "SUPABASE_SECRET_KEY",
  supabaseServiceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  frontendUrl: "FRONTEND_URL",
  backendUrl: "BACKEND_URL",
  kindeIssuerUrl: "KINDE_ISSUER_URL",
  kindeAudience: "KINDE_AUDIENCE",
  kindeClientId: "KINDE_CLIENT_ID",
  kindeClientSecret: "KINDE_CLIENT_SECRET",
  razorpayKeyId: "RAZORPAY_KEY_ID",
  razorpayKeySecret: "RAZORPAY_KEY_SECRET",
  razorpayWebhookSecret: "RAZORPAY_WEBHOOK_SECRET",
  razorpayBasicPlanId: "RAZORPAY_BASIC_PLAN_ID",
  adminEmails: "ADMIN_EMAILS"
};

export function requireEnv(keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    const names = missing.map((key) => envKeyNames[key] || key);
    throw new Error(`Missing required environment variables: ${names.join(", ")}`);
  }
}
