export const PDF_BUCKET = "client-pdfs";

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

export function buildStoragePath({ userId, clientId, documentId, fileName }) {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${PDF_BUCKET}/${userId}/${clientId}/${documentId}/${safeFileName}`;
}

export function objectPathFromStoragePath(storagePath) {
  return storagePath.startsWith(`${PDF_BUCKET}/`)
    ? storagePath.slice(PDF_BUCKET.length + 1)
    : storagePath;
}
