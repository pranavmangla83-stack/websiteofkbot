import pg from "pg";
import { env, requireEnv } from "../config/env.js";

let pool;

export function getPool() {
  requireEnv(["databaseUrl"]);

  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.databaseUrl,
      max: env.pgPoolMax,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000
    });
  }

  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
