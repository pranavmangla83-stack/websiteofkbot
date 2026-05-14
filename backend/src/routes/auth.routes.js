import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { syncUserAndTenant } from "../services/accounts.js";

export const authRouter = express.Router();

authRouter.post("/sync-user", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    res.json(account);
  } catch (error) {
    next(error);
  }
});
