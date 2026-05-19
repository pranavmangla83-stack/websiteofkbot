import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { query, withTransaction } from "../db/pool.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { assertCanUploadPdf } from "../services/entitlements.js";
import { syncUserAndTenant } from "../services/accounts.js";
import { DOCUMENT_STATUS, buildStoragePath, objectPathFromStoragePath, PDF_BUCKET } from "../services/pdf-metadata.js";

const MAX_PDF_BYTES = 7 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PDF_BYTES,
    files: 1
  }
});

export const documentsRouter = express.Router();

documentsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const result = await query(
      `
        SELECT id, file_name, file_size, storage_path, status, error_message, page_count, source_type, ocr_confidence, created_at, updated_at
        FROM documents
        WHERE user_id = $1 AND client_id = $2
        ORDER BY created_at DESC
      `,
      [account.client.id, account.client.id]
    );

    res.json({ documents: result.rows });
  } catch (error) {
    next(error);
  }
});

documentsRouter.post("/upload", requireAuth, loadAccount, upload.single("pdf"), async (req, res, next) => {
  try {
    const account = req.account;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "PDF file is required. Use form field name 'pdf'." });
    }

    if (file.mimetype !== "application/pdf" && !file.originalname.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Only PDF files are allowed." });
    }

    if (file.size > MAX_PDF_BYTES) {
      return res.status(400).json({ error: "PDF must be 7MB or smaller." });
    }

    const documentId = crypto.randomUUID();
    const storagePath = buildStoragePath({
      userId: account.client.id,
      clientId: account.client.id,
      documentId,
      fileName: file.originalname
    });
    const objectPath = objectPathFromStoragePath(storagePath);

    let inserted;
    try {
      inserted = await withTransaction(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [account.client.id]);
        await assertCanUploadPdf(db, account);

        return db.query(
          `
            INSERT INTO documents (
              id,
              user_id,
              client_id,
              chatbot_id,
              file_name,
              file_size,
              storage_path,
              status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, file_name, file_size, storage_path, status, error_message, source_type, ocr_confidence, created_at, updated_at
          `,
          [
            documentId,
            account.client.id,
            account.client.id,
            account.chatbot.id,
            file.originalname,
            file.size,
            storagePath,
            DOCUMENT_STATUS.UPLOADING
          ]
        );
      });
    } catch (error) {
      throw error;
    }

    const { error: uploadError } = await getSupabaseAdmin().storage
      .from(PDF_BUCKET)
      .upload(objectPath, file.buffer, {
        contentType: "application/pdf",
        upsert: false
      });

    if (uploadError) {
      await query("DELETE FROM documents WHERE id = $1 AND client_id = $2", [documentId, account.client.id])
        .catch((cleanupError) => {
          console.error(`Failed to clean up PDF row after storage failure for ${documentId}:`, cleanupError);
        });
      await getSupabaseAdmin().storage
        .from(PDF_BUCKET)
        .remove([objectPath])
        .catch((cleanupError) => {
          console.error(`Failed to clean up orphaned PDF ${objectPath}:`, cleanupError);
        });

      throw Object.assign(new Error(uploadError.message), {
        statusCode: 500,
        publicMessage: "PDF upload storage failed. Please try again in a few minutes."
      });
    }

    processDocument(documentId, { clientId: account.client.id }).catch((error) => {
      console.error(`Background PDF processing failed for ${documentId}:`, error);
    });

    res.status(201).json({
      document: inserted.rows[0],
      processing_started: true
    });
  } catch (error) {
    next(error);
  }
});

async function loadAccount(req, _res, next) {
  try {
    req.account = await syncUserAndTenant(req.auth);
    next();
  } catch (error) {
    next(error);
  }
}

documentsRouter.post("/:id/process", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const document = await getOwnedDocument(req.params.id, account.client.id);

    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    const result = await processDocument(document.id, { clientId: account.client.id });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

documentsRouter.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const account = await syncUserAndTenant(req.auth);
    const document = await getOwnedDocument(req.params.id, account.client.id);

    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    const { error: storageError } = await getSupabaseAdmin().storage
      .from(PDF_BUCKET)
      .remove([objectPathFromStoragePath(document.storage_path)]);

    if (storageError) {
      throw Object.assign(new Error(storageError.message), {
        statusCode: 500,
        publicMessage: "Could not delete this PDF right now. Please try again in a few minutes."
      });
    }

    await withTransaction(async (db) => {
      await db.query("DELETE FROM document_chunks WHERE document_id = $1 AND client_id = $2", [document.id, account.client.id]);
      await db.query("DELETE FROM documents WHERE id = $1 AND client_id = $2", [document.id, account.client.id]);
    });

    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

async function getOwnedDocument(documentId, clientId) {
  if (!isUuid(documentId)) return null;

  const result = await query(
    "SELECT * FROM documents WHERE id = $1 AND user_id = $2 AND client_id = $2 LIMIT 1",
    [documentId, clientId]
  );

  return result.rows[0] || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

async function processDocument(documentId, options) {
  const { processDocument: runProcessDocument } = await import("../services/pdf-processing.js");
  return runProcessDocument(documentId, options);
}
