/**
 * Opening the shared history database. Every process (servers, the sweep, the hook)
 * opens the same file; WAL lets readers run while one writer commits.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { migrate, SCHEMA_VERSION, SchemaTooNewError } from "./schema.js";

export type DB = Database.Database;

export interface OpenOptions {
  /** Create the file (and run migrations) when it does not exist. Default false. */
  create?: boolean;
  readonly?: boolean;
  /** How long a statement waits for a lock before failing with SQLITE_BUSY. */
  busyTimeoutMs?: number;
  /**
   * Bring the schema up to date (default true for a writable connection). Servers pass
   * false: a migration can rewrite the whole database, which is the sweep's job, not a
   * tool call's.
   */
  migrate?: boolean;
}

export class DatabaseOutdatedError extends Error {
  constructor(readonly path: string, readonly found: number) {
    super(`The history database at ${path} has schema version ${found}; this build needs ${SCHEMA_VERSION}.`);
    this.name = "DatabaseOutdatedError";
  }
}

export class DatabaseMissingError extends Error {
  constructor(readonly path: string) {
    super(`No history database at ${path}.`);
    this.name = "DatabaseMissingError";
  }
}

export function openDatabase(path: string, options: OpenOptions = {}): DB {
  const { create = false, readonly = false, busyTimeoutMs = 5_000 } = options;
  const runMigrations = !readonly && (options.migrate ?? true);
  if (!existsSync(path)) {
    if (!create || readonly) throw new DatabaseMissingError(path);
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { readonly, fileMustExist: !create });
  db.pragma(`busy_timeout = ${Math.max(0, Math.round(busyTimeoutMs))}`);
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    // Keep the WAL file from staying at its high-water mark after a big sweep.
    db.pragma("journal_size_limit = 67108864");
  }
  if (runMigrations) {
    migrate(db);
  } else {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new SchemaTooNewError(version, SCHEMA_VERSION);
    }
    if (version < SCHEMA_VERSION) {
      db.close();
      throw new DatabaseOutdatedError(path, version);
    }
  }
  db.pragma("cache_size = -16000"); // 16 MB page cache per connection
  db.pragma("temp_store = MEMORY");
  return db;
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/** Run `fn` with the connection's busy timeout temporarily set to `ms`. */
export function withBusyTimeout<T>(db: DB, ms: number, fn: () => T): T {
  const previous = db.pragma("busy_timeout", { simple: true }) as number;
  db.pragma(`busy_timeout = ${Math.max(0, Math.round(ms))}`);
  try {
    return fn();
  } finally {
    db.pragma(`busy_timeout = ${previous}`);
  }
}

export function isBusyError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? "";
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}
