import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requireAuth } from "./middleware/auth.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { billingRouter, handleRazorpayWebhook } from "./routes/billing.routes.js";
import { chatRouter } from "./routes/chat.routes.js";
import { documentsRouter } from "./routes/documents.routes.js";
import { meRouter } from "./routes/me.routes.js";
import { scriptRouter } from "./routes/script.routes.js";
import { testDbRouter } from "./routes/test-db.routes.js";
import { widgetRouter } from "./routes/widget.routes.js";

export const app = express();

const adminCors = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    return callback(null, origin === env.frontendUrl);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
});

const publicCors = cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
});

app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleRazorpayWebhook
);

app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleRazorpayWebhook
);

app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "customaichatbot-backend",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/auth", adminCors, authRouter);
app.use("/api/me", adminCors, meRouter);
app.use("/api/admin", adminCors, adminRouter);
app.use("/api/billing", adminCors, billingRouter);
app.use("/api/documents", adminCors, documentsRouter);
app.use("/api/chat", publicCors, chatRouter);
app.use("/api", adminCors, scriptRouter);
app.use("/api/db", adminCors, requireAuth, testDbRouter);
app.use("/api/test-db", adminCors, requireAuth, testDbRouter);
app.use(publicCors, widgetRouter);

app.use(notFound);
app.use(errorHandler);
