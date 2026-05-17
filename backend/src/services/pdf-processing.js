import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import pdfParse from "pdf-parse";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import { query, withTransaction } from "../db/pool.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { createEmbedding } from "./openai.js";
import { env } from "../config/env.js";

export const PDF_BUCKET = "client-pdfs";
const CHUNK_TARGET_CHARS = 4200;
const CHUNK_OVERLAP_CHARS = 600;
const MAX_CHUNKS_PER_DOCUMENT = 250;
const MIN_READABLE_TEXT_CHARS = 120;
const MIN_READABLE_RATIO = 0.55;
const MAX_PDF_PAGES = 40;
const OCR_RENDER_SCALE = 2;
const MAX_OCR_RENDER_PIXELS = 8_000_000;
const OCR_PAGE_TIMEOUT_MS = 90_000;
const MIN_OCR_CONFIDENCE = 45;

export const DOCUMENT_STATUS = {
  UPLOADING: "uploading_pdf",
  EXTRACTING_TEXT: "extracting_pdf_text",
  SCANNED_DETECTED: "scanned_pdf_detected",
  RUNNING_OCR: "running_ocr",
  CREATING_CHUNKS: "creating_chunks",
  SAVING_KNOWLEDGE_BASE: "saving_knowledge_base",
  COMPLETED: "completed",
  FAILED: "failed"
};

const LOW_QUALITY_OCR_MESSAGE = "This scanned PDF quality is low. Please upload a clearer PDF for better chatbot accuracy.";

export async function processDocument(documentId, { clientId } = {}) {
  return enqueuePdfProcessing(() => processDocumentNow(documentId, { clientId }));
}

async function processDocumentNow(documentId, { clientId } = {}) {
  if (!clientId) {
    throw new Error("clientId is required to process a document.");
  }

  const document = await getDocumentForProcessing(documentId, { clientId });
  if (!document) {
    throw Object.assign(new Error("Document not found"), { statusCode: 404 });
  }

  try {
    await updateDocumentStatus(document, DOCUMENT_STATUS.EXTRACTING_TEXT);

    const objectPath = objectPathFromStoragePath(document.storage_path);
    const { data, error } = await getSupabaseAdmin().storage
      .from(PDF_BUCKET)
      .download(objectPath);

    if (error) throw new Error(error.message);

    const pdfBuffer = Buffer.from(await data.arrayBuffer());
    const processed = await preparePdfForKnowledgeBase({
      pdfBuffer,
      onStatus: (status) => updateDocumentStatus(document, status)
    });
    const embeddedChunks = await createEmbeddedChunks(processed.chunks, createEmbedding);

    await updateDocumentStatus(document, DOCUMENT_STATUS.SAVING_KNOWLEDGE_BASE);
    await withTransaction(async (db) => {
      await db.query(
        "DELETE FROM document_chunks WHERE document_id = $1 AND client_id = $2",
        [document.id, document.client_id]
      );

      for (const chunk of embeddedChunks) {
        await db.query(
          `
            INSERT INTO document_chunks (
              document_id,
              user_id,
              client_id,
              chatbot_id,
              chunk_index,
              chunk_text,
              embedding,
              token_count,
              page_number,
              source_type,
              ocr_confidence,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10, $11, $12)
          `,
          [
            document.id,
            document.user_id,
            document.client_id,
            document.chatbot_id,
            chunk.index,
            chunk.chunkText,
            vectorToSql(chunk.embedding),
            chunk.tokenCount,
            chunk.pageNumber,
            chunk.sourceType,
            chunk.ocrConfidence,
            {
              document_id: document.id,
              client_id: document.client_id,
              user_id: document.user_id,
              file_name: document.file_name,
              chunk_index: chunk.index,
              total_chunks: embeddedChunks.length,
              page_number: chunk.pageNumber,
              source_type: chunk.sourceType,
              ocr_confidence: chunk.ocrConfidence
            }
          ]
        );
      }

      await db.query(
        `
          UPDATE documents
          SET status = $2,
              error_message = NULL,
              page_count = $3,
              source_type = $4,
              ocr_confidence = $5,
              updated_at = now()
          WHERE id = $1 AND client_id = $6
        `,
        [
          document.id,
          DOCUMENT_STATUS.COMPLETED,
          processed.pageCount || null,
          processed.sourceType,
          processed.ocrConfidence,
          document.client_id
        ]
      );
    });

    return {
      id: document.id,
      status: DOCUMENT_STATUS.COMPLETED,
      source_type: processed.sourceType,
      ocr_confidence: processed.ocrConfidence,
      chunks_created: embeddedChunks.length
    };
  } catch (error) {
    await query(
      `
        UPDATE documents
        SET status = $2,
            error_message = $3,
            updated_at = now()
        WHERE id = $1 AND client_id = $4
      `,
      [document.id, DOCUMENT_STATUS.FAILED, userSafePdfError(error), document.client_id]
    );
    await clearDocumentChunks(document).catch((cleanupError) => {
      console.error(`Failed to clear chunks after PDF processing failure for ${document.id}:`, cleanupError);
    });

    throw error;
  }
}

const pdfProcessingQueue = [];
let activePdfProcessingJobs = 0;

function enqueuePdfProcessing(job) {
  return new Promise((resolve, reject) => {
    pdfProcessingQueue.push({ job, resolve, reject });
    drainPdfProcessingQueue();
  });
}

function drainPdfProcessingQueue() {
  const concurrency = Math.max(1, env.pdfProcessingConcurrency);

  while (activePdfProcessingJobs < concurrency && pdfProcessingQueue.length) {
    const queued = pdfProcessingQueue.shift();
    activePdfProcessingJobs += 1;

    queued.job()
      .then(queued.resolve, queued.reject)
      .finally(() => {
        activePdfProcessingJobs -= 1;
        drainPdfProcessingQueue();
      });
  }
}

export async function preparePdfForKnowledgeBase({ pdfBuffer, onStatus = async () => {} }) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error("Empty PDF. Please upload a PDF with readable content.");
  }

  const normalizedPdfBuffer = exactBuffer(pdfBuffer);
  let parsed;
  try {
    parsed = await pdfParse(normalizedPdfBuffer);
  } catch (error) {
    parsed = await extractTextWithPdfJs(normalizedPdfBuffer).catch(() => {
      throw normalizePdfParseError(error);
    });
  }

  const pageCount = parsed.numpages || null;
  ensurePageLimit(pageCount);

  const text = cleanPdfText(parsed.text || "");
  if (isReadableExtractedText(text)) {
    await onStatus(DOCUMENT_STATUS.CREATING_CHUNKS);
    const chunks = buildChunkRecords([{ text, pageNumber: null, sourceType: "pdf_text", ocrConfidence: null }]);
    ensureChunks(chunks);
    return {
      pageCount,
      sourceType: "pdf_text",
      ocrConfidence: null,
      chunks
    };
  }

  await onStatus(DOCUMENT_STATUS.SCANNED_DETECTED);
  await onStatus(DOCUMENT_STATUS.RUNNING_OCR);

  const ocrPages = await extractTextWithOcr(normalizedPdfBuffer, { expectedPageCount: pageCount });
  const readablePages = ocrPages.filter((page) => isReadableExtractedText(page.text, { minChars: 20 }));
  const combinedText = cleanPdfText(ocrPages.map((page) => page.text).join("\n\n"));
  const averageConfidence = average(ocrPages.map((page) => page.ocrConfidence).filter((value) => value !== null));

  if (
    !isReadableExtractedText(combinedText) ||
    !readablePages.length ||
    (averageConfidence !== null && averageConfidence < MIN_OCR_CONFIDENCE)
  ) {
    throw new Error(LOW_QUALITY_OCR_MESSAGE);
  }

  await onStatus(DOCUMENT_STATUS.CREATING_CHUNKS);
  const chunks = buildChunkRecords(ocrPages.map((page) => ({
    text: page.text,
    pageNumber: page.pageNumber,
    sourceType: "ocr",
    ocrConfidence: page.ocrConfidence
  })));
  ensureChunks(chunks);

  return {
    pageCount: pageCount || ocrPages.length,
    sourceType: "ocr",
    ocrConfidence: averageConfidence,
    chunks
  };
}

function exactBuffer(buffer) {
  return Buffer.from(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export function cleanPdfText(text) {
  return text
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitTextIntoChunks(text) {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if ((current.length + paragraph.length + 2) <= CHUNK_TARGET_CHARS) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }

    chunks.push(current);
    current = `${current.slice(-CHUNK_OVERLAP_CHARS)}\n\n${paragraph}`.trim();
  }

  if (current) chunks.push(current);

  return chunks.flatMap((chunk) => {
    if (chunk.length <= CHUNK_TARGET_CHARS * 1.4) return [chunk];

    const parts = [];
    for (let i = 0; i < chunk.length; i += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS) {
      parts.push(chunk.slice(i, i + CHUNK_TARGET_CHARS).trim());
    }
    return parts.filter(Boolean);
  });
}

export function buildStoragePath({ userId, clientId, documentId, fileName }) {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${PDF_BUCKET}/${userId}/${clientId}/${documentId}/${safeFileName}`;
}

export function objectPathFromStoragePath(storagePath) {
  return storagePath.startsWith(`${PDF_BUCKET}/`)
    ? storagePath.slice(PDF_BUCKET.length + 1)
    : storagePath;
}

function getDocumentForProcessing(documentId, { clientId } = {}) {
  return query("SELECT * FROM documents WHERE id = $1 AND client_id = $2", [documentId, clientId])
    .then((result) => result.rows[0] || null);
}

function updateDocumentStatus(document, status) {
  return query(
    `
      UPDATE documents
      SET status = $2,
          error_message = NULL,
          updated_at = now()
      WHERE id = $1 AND client_id = $3
    `,
    [document.id, status, document.client_id]
  );
}

function vectorToSql(embedding) {
  return `[${embedding.join(",")}]`;
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function createEmbeddedChunks(chunks, embeddingFn) {
  const embeddedChunks = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const embedding = await embeddingFn(chunk.chunkText);

    embeddedChunks.push({
      index,
      chunkText: chunk.chunkText,
      embedding,
      tokenCount: estimateTokens(chunk.chunkText),
      pageNumber: chunk.pageNumber,
      sourceType: chunk.sourceType,
      ocrConfidence: chunk.ocrConfidence
    });
  }

  return embeddedChunks;
}

function buildChunkRecords(sections) {
  return sections.flatMap((section) => {
    const text = cleanPdfText(section.text || "");
    if (!text) return [];

    return splitTextIntoChunks(text).map((chunkText) => ({
      chunkText,
      pageNumber: section.pageNumber,
      sourceType: section.sourceType,
      ocrConfidence: section.ocrConfidence
    }));
  });
}

function ensureChunks(chunks) {
  if (!chunks.length) {
    throw new Error("No readable text was found in this PDF.");
  }

  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new Error(`PDF is too large for processing. Please upload a smaller PDF with fewer than ${MAX_CHUNKS_PER_DOCUMENT} text chunks.`);
  }
}

function clearDocumentChunks(document) {
  return query(
    "DELETE FROM document_chunks WHERE document_id = $1 AND client_id = $2",
    [document.id, document.client_id]
  );
}

function isReadableExtractedText(text, { minChars = MIN_READABLE_TEXT_CHARS } = {}) {
  const compact = String(text || "").replace(/\s/g, "");
  if (compact.length < minChars) return false;

  const readableChars = compact.match(/[A-Za-z0-9.,;:!?'"()$%&/@#\-]/g)?.length || 0;
  return readableChars / compact.length >= MIN_READABLE_RATIO;
}

async function extractTextWithOcr(pdfBuffer, { expectedPageCount }) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages || expectedPageCount || 0;
  ensurePageLimit(pageCount);

  if (!pageCount) {
    throw new Error("Empty PDF. Please upload a PDF with readable content.");
  }

  const tesseractCachePath = path.join(os.tmpdir(), "websiteofkbot-tesseract");
  await fs.mkdir(tesseractCachePath, { recursive: true });
  const worker = await createWorker("eng", 1, {
    cachePath: tesseractCachePath
  });

  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const image = await renderPdfPageToPng(pdf, pageNumber);
      const result = await withTimeout(
        worker.recognize(image),
        OCR_PAGE_TIMEOUT_MS,
        `OCR timeout while reading page ${pageNumber}.`
      );
      const pageText = cleanPdfText(result.data?.text || "");
      pages.push({
        pageNumber,
        text: pageText,
        ocrConfidence: normalizeConfidence(result.data?.confidence)
      });
    }

    return pages;
  } catch (error) {
    if (/timeout/i.test(error.message || "")) throw error;
    throw new Error(`Failed page conversion or OCR: ${error.message || "Unknown OCR error"}`);
  } finally {
    await worker.terminate().catch(() => {});
    await pdf.destroy().catch(() => {});
  }
}

async function extractTextWithPdfJs(pdfBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;

  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join(" "));
      page.cleanup();
    }

    return {
      numpages: pdf.numPages,
      text: pages.join("\n\n")
    };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

async function renderPdfPageToPng(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = safeRenderScale(baseViewport, OCR_RENDER_SCALE);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext("2d");

  await page.render({
    canvasContext,
    viewport
  }).promise;

  page.cleanup();
  return canvas.toBuffer("image/png");
}

function safeRenderScale(viewport, preferredScale) {
  const preferredPixels = viewport.width * viewport.height * preferredScale * preferredScale;
  if (preferredPixels <= MAX_OCR_RENDER_PIXELS) return preferredScale;

  const scale = Math.sqrt(MAX_OCR_RENDER_PIXELS / (viewport.width * viewport.height));
  return Math.max(1, Math.min(preferredScale, scale));
}

function ensurePageLimit(pageCount) {
  if (pageCount && pageCount > MAX_PDF_PAGES) {
    throw new Error(`PDF is too large for processing. Please upload a PDF with ${MAX_PDF_PAGES} pages or fewer.`);
  }
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function average(values) {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function normalizePdfParseError(error) {
  const message = String(error?.message || "PDF parsing failed");
  if (/password|encrypted/i.test(message)) {
    return new Error("Password-protected PDF files are not supported. Please upload an unlocked PDF.");
  }
  if (/invalid|corrupt|bad xref|xref|format|header/i.test(message)) {
    return new Error("Corrupt PDF. Please upload a valid PDF file.");
  }
  return new Error(`PDF text extraction failed: ${message}`);
}

function userSafePdfError(error) {
  const message = String(error?.message || "PDF processing failed");
  if (message.includes(LOW_QUALITY_OCR_MESSAGE)) return LOW_QUALITY_OCR_MESSAGE;
  return message;
}
