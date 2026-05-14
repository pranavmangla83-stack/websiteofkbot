import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

let supabaseAdmin;

export function getSupabaseAdmin() {
  const backendKey = env.supabaseSecretKey || env.supabaseServiceRoleKey;

  if (!env.supabaseUrl || !backendKey) {
    throw new Error("Missing required environment variables: SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY");
  }

  if (!supabaseAdmin) {
    supabaseAdmin = createClient(env.supabaseUrl, backendKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }

  return supabaseAdmin;
}
