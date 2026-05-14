import express from "express";
import { getSupabaseAdmin } from "../lib/supabase.js";

export const testDbRouter = express.Router();

testDbRouter.get("/", async (req, res, next) => {
  try {
    const { count, error } = await getSupabaseAdmin()
      .from("clients")
      .select("id", { count: "exact", head: true });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    res.json({
      ok: true,
      provider: "supabase",
      clients_count: count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message?.startsWith("Missing required environment variables:")) {
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    next(error);
  }
});
