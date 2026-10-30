/**
 * SQLite through Node's built-in `node:sqlite`: no native build step, one file
 * on disk, trivially backed up. Migrations are an ordered list keyed by
 * `PRAGMA user_version`; append to the list, never edit an entry that shipped.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import crypto from "node:crypto";
import { MIGRATIONS } from "./migrations.ts";

export type DB = DatabaseSync;
export type Row = Record<string, unknown>;

export function openDb(dataDir: string, file = "catch.db"): DB {
  const db = new DatabaseSync(file === ":memory:" ? ":memory:" : path.join(dataDir, file));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

let depth = 0;
/** Nested calls join the outer transaction rather than failing. */
export function tx<T>(db: DB, fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth--;
  }
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function one<T = Row>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T = Row>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(db: DB, sql: string, ...params: unknown[]): { changes: number } {
  const r = db.prepare(sql).run(...(params as never[]));
  return { changes: Number(r.changes) };
}

/** Insert a plain object. Keys are trusted (they come from code, never input). */
export function insert(db: DB, table: string, row: Row): void {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  run(db, sql, ...keys.map((k) => normalise(row[k])));
}

export function update(db: DB, table: string, idValue: string, patch: Row): void {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  run(db, sql, ...keys.map((k) => normalise(patch[k])), idValue);
}

function normalise(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
