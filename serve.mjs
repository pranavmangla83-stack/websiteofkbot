import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.STATIC_PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  const pathname = safeDecodePath(req.url || "/");

  if (pathname === "/api/monitoring-config") {
    sendJson(res, {
      sentryFrontendDsn: process.env.SENTRY_FRONTEND_DSN?.trim() || "",
      clarityProjectId: process.env.CLARITY_PROJECT_ID?.trim() || "",
      environment: process.env.NODE_ENV || "development"
    });
    return;
  }

  serveStaticFile(res, pathname);
});

server.listen(port, host, () => {
  console.log(`Static server running at http://${host}:${port}`);
});

function serveStaticFile(res, pathname) {
  const cleanPath = pathname.split("?")[0].split("#")[0];
  const routeMap = new Map([
    ["/", "/index.html"],
    ["/dashboard", "/dashboard.html"],
    ["/client", "/dashboard.html"],
    ["/admin", "/admin.html"],
    ["/privacy", "/privacy.html"],
    ["/terms", "/terms.html"],
    ["/refund", "/refund.html"]
  ]);
  const reqPath = routeMap.get(cleanPath) || cleanPath;
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    sendFile(res, filePath);
  });
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = mimeTypes[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, body) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function safeDecodePath(url) {
  const rawPath = String(url).split("?")[0].split("#")[0] || "/";
  try {
    return decodeURIComponent(rawPath);
  } catch (_error) {
    return rawPath;
  }
}
