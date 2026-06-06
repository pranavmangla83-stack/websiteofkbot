import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

try {
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  const seed = await fs.readFile(path.join(__dirname, "seed.sql"), "utf8");

  await pool.query(schema);
  await runMigrations();
  await pool.query(seed);

  console.log("Database schema migrated and plans seeded.");
} finally {
  await pool.end();
}

async function runMigrations() {
  const migrationsDir = path.join(__dirname, "migrations");
  let migrationFiles = [];

  try {
    migrationFiles = await fs.readdir(migrationsDir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const fileName of migrationFiles.filter((file) => file.endsWith(".sql")).sort()) {
    const sql = await fs.readFile(path.join(migrationsDir, fileName), "utf8");
    await pool.query(sql);
    console.log(`Applied migration ${fileName}`);
  }
}
