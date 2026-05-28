import dotenv from "dotenv";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 4000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const frontendRoutes = new Map([
  ["/", "/index.html"],
  ["/index.html", "/index.html"],
  ["/dashboard", "/dashboard.html"],
  ["/dashboard.html", "/dashboard.html"],
  ["/client", "/dashboard.html"],
  ["/admin", "/admin.html"],
  ["/admin.html", "/admin.html"],
  ["/privacy", "/privacy.html"],
  ["/privacy.html", "/privacy.html"],
  ["/terms", "/terms.html"],
  ["/terms.html", "/terms.html"],
  ["/refund", "/refund.html"],
  ["/refund.html", "/refund.html"],
  ["/robots.txt", "/robots.txt"]
]);

let backendAppPromise;

const server = http.createServer(async (req, res) => {
  if (isBlockedScannerRequest(req)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const pathname = safeDecodePath(req.url || "/");

  if (pathname.startsWith("/api/") || pathname === "/widget.js") {
    await handleBackendRequest(req, res);
    return;
  }

  serveStaticRequest(pathname, res);
});

server.requestTimeout = 180_000;
server.headersTimeout = 185_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.log(`Website server running on ${host}:${port}`);
});

async function handleBackendRequest(req, res) {
  try {
    const app = await getBackendApp();
    app(req, res);
  } catch (error) {
    console.error("Backend failed to load:", error);
    sendText(res, 503, "Backend temporarily unavailable");
  }
}

async function getBackendApp() {
  if (!backendAppPromise) {
    backendAppPromise = import("./backend/src/app.js")
      .then((module) => module.app)
      .catch((error) => {
        backendAppPromise = null;
        throw error;
      });
  }

  return backendAppPromise;
}

function serveStaticRequest(pathname, res) {
  const mappedPath = frontendRoutes.get(pathname) || pathname;
  const filePath = resolvePublicPath(mappedPath);

  if (!filePath) {
    sendText(res, 404, "Not found");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    sendFile(res, filePath);
  });
}

function resolvePublicPath(requestPath) {
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, normalized);
  const relative = path.relative(__dirname, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return filePath;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = mimeTypes[ext] || "application/octet-stream";
  const cacheControl = cacheHeaderFor(filePath);

  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": cacheControl
  });
  fs.createReadStream(filePath).pipe(res);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function safeDecodePath(url) {
  const rawPath = String(url).split("?")[0].split("#")[0] || "/";
  try {
    return decodeURIComponent(rawPath);
  } catch (_error) {
    return rawPath;
  }
}

function cacheHeaderFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".ico"].includes(ext)) {
    return "public, max-age=604800";
  }
  if (ext === ".html") {
    return "public, max-age=300";
  }
  if (path.basename(filePath) === "robots.txt") {
    return "public, max-age=3600";
  }
  return "no-store";
}

function isBlockedScannerRequest(req) {
  const pathname = safeDecodePath(req.url || "/");
  const userAgent = req.headers["user-agent"] || "";
  const blockedPath = /^\/(?:wp-admin|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|wordpress|phpmyadmin|pma|adminer|\.env|\.git|vendor|composer\.(?:json|lock))(?:\/|$)/i;
  const blockedUserAgent = /\b(?:aiohttp|python-requests|python\/|curl|wget|nikto|sqlmap|masscan|zgrab)\b|headlesschrome|cms-checker|internetmeasurement/i;
  const allowedGoogleCrawler = /\b(?:AdsBot-Google|Googlebot|Google-InspectionTool|Mediapartners-Google|APIs-Google)\b/i;

  if (allowedGoogleCrawler.test(userAgent)) return blockedPath.test(pathname);
  return blockedPath.test(pathname) || blockedUserAgent.test(userAgent);
}
