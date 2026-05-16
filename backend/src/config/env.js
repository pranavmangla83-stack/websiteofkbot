import dotenv from "dotenv";

dotenv.config();

const envValue = (key) => process.env[key]?.trim();

export const env = {
  port: Number(envValue("PORT") || 4000),
  host: envValue("HOST") || "0.0.0.0",
  databaseUrl: envValue("DATABASE_URL"),
  supabaseUrl: envValue("SUPABASE_URL"),
  supabaseAnonKey: envValue("SUPABASE_ANON_KEY"),
  supabasePublishableKey: envValue("SUPABASE_PUBLISHABLE_KEY") || envValue("SUPABASE_ANON_KEY"),
  supabaseSecretKey: envValue("SUPABASE_SECRET_KEY"),
  supabaseServiceRoleKey: envValue("SUPABASE_SERVICE_ROLE_KEY"),
  openaiApiKey: envValue("OPENAI_API_KEY"),
  frontendUrl: envValue("FRONTEND_URL") || "http://localhost:3000",
  backendUrl: envValue("BACKEND_URL") || "http://localhost:4000",
  kindeIssuerUrl: envValue("KINDE_ISSUER_URL"),
  kindeAudience: envValue("KINDE_AUDIENCE"),
  kindeClientId: envValue("KINDE_CLIENT_ID"),
  kindeClientSecret: envValue("KINDE_CLIENT_SECRET"),
  razorpayKeyId: envValue("RAZORPAY_KEY_ID"),
  razorpayKeySecret: envValue("RAZORPAY_KEY_SECRET"),
  razorpayWebhookSecret: envValue("RAZORPAY_WEBHOOK_SECRET"),
  razorpayBasicPlanId: envValue("RAZORPAY_BASIC_PLAN_ID"),
  resendApiKey: envValue("RESEND_API_KEY"),
  supportEmail: envValue("SUPPORT_EMAIL") || "Support@customaichatbot.online",
  notificationFromEmail: envValue("NOTIFICATION_FROM_EMAIL") || "Custom AI Chatbot <onboarding@resend.dev>",
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
  resendApiKey: "RESEND_API_KEY",
  supportEmail: "SUPPORT_EMAIL",
  notificationFromEmail: "NOTIFICATION_FROM_EMAIL",
  adminEmails: "ADMIN_EMAILS"
};

export function requireEnv(keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    const names = missing.map((key) => envKeyNames[key] || key);
    throw new Error(`Missing required environment variables: ${names.join(", ")}`);
  }
}
