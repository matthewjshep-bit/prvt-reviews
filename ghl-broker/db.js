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

// Apply schema.pg.sql on boot (idempotent). Best-effort: a failure here does
// not crash the broker, but it is no longer only a log line (2026-11-09). The
// schema runs as one multi-statement query, so one bad statement rolls back
// every new column with it: the result is kept for GET / (schema=failed) and
// handed back as { ok, error } so the boot can record it under db:migrate,
// which #machine hears.
let schema = { status: pool ? "pending" : "none", error: null, at: null };

/** schemaState() → { status: "none" (no database) | "pending" | "ok" | "failed", error, at } */
export function schemaState() { return { ...schema }; }

export async function migrate({ pool: p = pool, readSchema = null } = {}) {
  if (!p) return { ok: false, skipped: true, error: null };
  try {
    let sql;
    if (typeof readSchema === "function") sql = await readSchema();
    else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const url = await import("node:url");
      const dir = path.dirname(url.fileURLToPath(import.meta.url));
      sql = await fs.readFile(path.join(dir, "schema.pg.sql"), "utf8");
    }
    await p.query(sql);
    schema = { status: "ok", error: null, at: new Date().toISOString() };
    console.log("db: schema applied");
    return { ok: true, error: null };
  } catch (err) {
    const error = String(err?.message || err).slice(0, 300);
    schema = { status: "failed", error, at: new Date().toISOString() };
    console.error("db: migrate failed:", error);
    return { ok: false, error };
  }
}
