import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

export const widgetRouter = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const widgetPath = path.resolve(__dirname, "../widget/widget.js");

widgetRouter.get("/widget.js", (req, res) => {
  res.set({
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=300, stale-while-revalidate=86400"
  });
  res.sendFile(widgetPath);
});
