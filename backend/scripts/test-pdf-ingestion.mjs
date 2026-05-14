import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import PDFDocument from "pdfkit";
import { preparePdfForKnowledgeBase } from "../src/services/pdf-processing.js";

const args = parseArgs(process.argv.slice(2));

if (args.selfTest) {
  const fixtures = await createSelfTestFixtures();
  args.normal = fixtures.normal;
  args.scanned = fixtures.scanned;
  args.lowQuality = fixtures.lowQuality;
  args.corrupt = true;
}

if (!args.normal && !args.scanned && !args.lowQuality && !args.corrupt) {
  printUsage();
  process.exit(1);
}

const cases = [
  args.normal && { name: "Normal text PDF", path: args.normal, expectFailure: false },
  args.scanned && { name: "Scanned PDF", path: args.scanned, expectFailure: false },
  args.lowQuality && { name: "Low-quality OCR case", path: args.lowQuality, expectFailure: true },
  args.corrupt && { name: "Empty/corrupt PDF", buffer: Buffer.from("not a pdf"), expectFailure: true }
].filter(Boolean);

let failures = 0;

for (const testCase of cases) {
  try {
    const buffer = testCase.buffer || await fs.readFile(path.resolve(testCase.path));
    const statuses = [];
    const result = await preparePdfForKnowledgeBase({
      pdfBuffer: buffer,
      onStatus: async (status) => statuses.push(status)
    });

    if (testCase.expectFailure) {
      failures += 1;
      console.error(`FAIL ${testCase.name}: expected failure, got ${result.sourceType}`);
      continue;
    }

    console.log(`PASS ${testCase.name}`);
    console.log(`  source_type: ${result.sourceType}`);
    console.log(`  page_count: ${result.pageCount || "unknown"}`);
    console.log(`  chunks: ${result.chunks.length}`);
    console.log(`  ocr_confidence: ${result.ocrConfidence ?? "n/a"}`);
    console.log(`  statuses: ${statuses.join(" -> ") || "none"}`);
  } catch (error) {
    if (testCase.expectFailure) {
      console.log(`PASS ${testCase.name}`);
      console.log(`  failed_with: ${error.message}`);
      continue;
    }

    failures += 1;
    console.error(`FAIL ${testCase.name}: ${error.message}`);
  }
}

if (failures) process.exit(1);

function parseArgs(values) {
  const parsed = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--normal") parsed.normal = values[index += 1];
    else if (value === "--scanned") parsed.scanned = values[index += 1];
    else if (value === "--low-quality") parsed.lowQuality = values[index += 1];
    else if (value === "--corrupt") parsed.corrupt = true;
    else if (value === "--self-test") parsed.selfTest = true;
  }

  return parsed;
}

function printUsage() {
  const scriptName = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.log(`Usage: node ${scriptName} --self-test`);
  console.log(`   or: node ${scriptName} --normal ./text.pdf --scanned ./scan.pdf --low-quality ./bad-scan.pdf --corrupt`);
}

async function createSelfTestFixtures() {
  const directory = path.resolve("backend", "tmp", "pdf-tests");
  await fs.mkdir(directory, { recursive: true });

  const normal = path.join(directory, "normal-text.pdf");
  const scanned = path.join(directory, "scanned-image.pdf");
  const lowQuality = path.join(directory, "low-quality-scan.pdf");

  await writeTextPdf(normal);
  await writeImagePdf(scanned, createTextImagePng());
  await writeImagePdf(lowQuality, createBlankImagePng());

  return { normal, scanned, lowQuality };
}

function writeTextPdf(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "LETTER", margin: 72, compress: false });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => fs.writeFile(filePath, Buffer.concat(chunks)).then(resolve, reject));
    doc.on("error", reject);
    doc.fontSize(18).text("Knowledge Base Test Document", { underline: true });
    doc.moveDown();
    doc.fontSize(12).text([
      "This PDF contains normal selectable text for chatbot ingestion.",
      "The business offers installation, support, pricing guidance, and product documentation.",
      "Customers can ask about warranty, onboarding, and available service plans."
    ].join("\n\n"));
    doc.end();
  });
}

function writeImagePdf(filePath, imageBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "LETTER", margin: 36, compress: false });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => fs.writeFile(filePath, Buffer.concat(chunks)).then(resolve, reject));
    doc.on("error", reject);
    doc.image(imageBuffer, 36, 36, { fit: [540, 720] });
    doc.end();
  });
}

function createTextImagePng() {
  const canvas = createCanvas(1200, 1600);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  context.font = "52px Arial";
  context.fillText("Scanned Knowledge Base Test", 90, 160);
  context.font = "36px Arial";
  wrapText(context, "This image-only PDF should be detected as scanned and processed through OCR for chatbot answers.", 90, 260, 980, 58);
  wrapText(context, "Support includes onboarding, installation help, pricing guidance, warranty details, and service plan information.", 90, 520, 980, 58);
  return canvas.toBuffer("image/png");
}

function createBlankImagePng() {
  const canvas = createCanvas(1200, 1600);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/png");
}

function wrapText(context, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth) {
      context.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = candidate;
    }
  }

  if (line) context.fillText(line, x, y);
}
