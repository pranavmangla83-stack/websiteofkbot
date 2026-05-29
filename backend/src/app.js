import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import { blockScannerTraffic } from "./middleware/bot-blocker.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requireAuth } from "./middleware/auth.js";
import { adminRouter, requireAdmin } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { billingRouter, handleRazorpayWebhook } from "./routes/billing.routes.js";
import { chatRouter } from "./routes/chat.routes.js";
import { documentsRouter } from "./routes/documents.routes.js";
import { meRouter } from "./routes/me.routes.js";
import { scriptRouter } from "./routes/script.routes.js";
import { testDbRouter } from "./routes/test-db.routes.js";
import { widgetRouter } from "./routes/widget.routes.js";
import { websitePagesRouter } from "./routes/website-pages.routes.js";

export const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const allowedAdminOrigins = adminOrigins(env.frontendUrl);

const adminCors = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    return callback(null, allowedAdminOrigins.has(origin));
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

const authenticatedApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute and try again." }
});

const uploadApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload requests. Please wait and try again." }
});

const billingApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many billing requests. Please wait a minute and try again." }
});

app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(blockScannerTraffic);

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

app.use("/api/auth", adminCors, authenticatedApiLimiter, authRouter);
app.use("/api/me", adminCors, authenticatedApiLimiter, meRouter);
app.use("/api/admin", adminCors, authenticatedApiLimiter, adminRouter);
app.use("/api/billing", adminCors, billingApiLimiter, billingRouter);
app.use("/api/documents", adminCors, uploadApiLimiter, documentsRouter);
app.use("/api/website-pages", adminCors, authenticatedApiLimiter, websitePagesRouter);
app.use("/api/chat", publicCors, chatRouter);
app.use("/api", adminCors, scriptRouter);
app.use("/api/db", adminCors, requireAuth, requireAdmin, testDbRouter);
app.use("/api/test-db", adminCors, requireAuth, requireAdmin, testDbRouter);
app.use(publicCors, widgetRouter);

app.use("/assets", express.static(path.join(projectRoot, "assets")));

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(projectRoot, "robots.txt"));
});

const frontendRoutes = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/dashboard", "dashboard.html"],
  ["/dashboard.html", "dashboard.html"],
  ["/client", "dashboard.html"],
  ["/admin", "admin.html"],
  ["/admin.html", "admin.html"],
  ["/privacy", "privacy.html"],
  ["/privacy.html", "privacy.html"],
  ["/terms", "terms.html"],
  ["/terms.html", "terms.html"],
  ["/refund", "refund.html"],
  ["/refund.html", "refund.html"]
]);

app.get(Array.from(frontendRoutes.keys()), (req, res) => {
  res.sendFile(path.join(projectRoot, frontendRoutes.get(req.path)));
});

app.use(notFound);
app.use(errorHandler);

function adminOrigins(frontendUrl) {
  const origins = new Set();
  addOrigin(origins, frontendUrl);

  try {
    const url = new URL(frontendUrl);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      addOrigin(origins, url.origin);
    } else {
      url.hostname = `www.${url.hostname}`;
      addOrigin(origins, url.origin);
    }
  } catch (_error) {
    // Invalid frontend URLs are handled by the exact-origin check above.
  }

  return origins;
}

function addOrigin(origins, value) {
  if (!value) return;
  try {
    origins.add(new URL(value).origin);
  } catch (_error) {
    origins.add(value);
  }
}
