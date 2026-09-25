import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(moduleDir, "schema.sql");

export function createDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  if (dbPath !== ":memory:") {
    // WAL is not supported for in-memory databases; only enable it for the
    // real, file-backed instance used outside tests.
    db.exec("PRAGMA journal_mode = WAL");
  }

  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);

  return db;
}

/**
 * node:sqlite's DatabaseSync has no built-in `.transaction()` helper (unlike
 * better-sqlite3), so this wraps the standard BEGIN IMMEDIATE / COMMIT /
 * ROLLBACK pattern. BEGIN IMMEDIATE takes the write lock up front rather
 * than on first write, which matters once there is more than one process
 * touching the same file-backed database.
 *
 * Because DatabaseSync calls are synchronous and Node is single-threaded,
 * everything inside `fn` runs to completion before any other request in
 * this process can touch the database — as long as `fn` contains no
 * `await`. That gives checkout and coupon redemption effectively
 * serializable isolation without explicit row locks, for a single process.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    err.message.includes("UNIQUE constraint failed")
  );
}
