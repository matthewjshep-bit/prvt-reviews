// db.js — Postgres connection for the Card Studio tables.
//
// The broker must still boot when DATABASE_URL is unset (e.g. someone runs it
// only for the legacy Messaging endpoints, or a first deploy before the DB is
// provisioned). So this module exports `dbEnabled`; when false, store.js falls
// back to a local JSON file so template CRUD still works in dev.

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "";
export const dbEnabled = Boolean(DATABASE_URL);

// Render-managed Postgres terminates TLS with a cert the pg client won't verify
// by default. Enable SSL (relaxed) for non-local hosts unless explicitly told
// otherwise via PGSSL=disable.
function sslConfig(url) {
  if (process.env.PGSSL === "disable") return false;
  if (process.env.PGSSL === "require") return { rejectUnauthorized: false };
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])/.test(url) || /host=localhost/.test(url);
  return isLocal ? false : { rejectUnauthorized: false };
}

export const pool = dbEnabled
  ? new Pool({ connectionString: DATABASE_URL, ssl: sslConfig(DATABASE_URL), max: 8 })
  : null;

if (pool) {
  pool.on("error", (err) => console.error("pg pool error:", err.message));
}

export async function query(text, params) {
  if (!pool) throw new Error("database not configured");
  return pool.query(text, params);
}

// Apply schema.pg.sql on boot (idempotent). Best-effort: a failure here logs
// but does not crash the broker.
export async function migrate() {
  if (!pool) return false;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const sql = await fs.readFile(path.join(dir, "schema.pg.sql"), "utf8");
    await pool.query(sql);
    console.log("db: schema applied");
    return true;
  } catch (err) {
    console.error("db: migrate failed:", err.message);
    return false;
  }
}
