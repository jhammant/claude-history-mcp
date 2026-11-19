/**
 * Opening the shared history database. Every process (servers, the sweep, the hook)
 * opens the same file; WAL lets readers run while one writer commits.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { migrate, SCHEMA_VERSION, SchemaTooNewError } from "./schema.js";
export class DatabaseOutdatedError extends Error {
    path;
    found;
    constructor(path, found) {
        super(`The history database at ${path} has schema version ${found}; this build needs ${SCHEMA_VERSION}.`);
        this.path = path;
        this.found = found;
        this.name = "DatabaseOutdatedError";
    }
}
export class DatabaseMissingError extends Error {
    path;
    constructor(path) {
        super(`No history database at ${path}.`);
        this.path = path;
        this.name = "DatabaseMissingError";
    }
}
export function openDatabase(path, options = {}) {
    const { create = false, readonly = false, busyTimeoutMs = 5_000 } = options;
    const runMigrations = !readonly && (options.migrate ?? true);
    if (!existsSync(path)) {
        if (!create || readonly)
            throw new DatabaseMissingError(path);
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
    }
    else {
        const version = db.pragma("user_version", { simple: true });
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
export function getMeta(db, key) {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value;
}
export function setMeta(db, key, value) {
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
/** Run `fn` with the connection's busy timeout temporarily set to `ms`. */
export function withBusyTimeout(db, ms, fn) {
    const previous = db.pragma("busy_timeout", { simple: true });
    db.pragma(`busy_timeout = ${Math.max(0, Math.round(ms))}`);
    try {
        return fn();
    }
    finally {
        db.pragma(`busy_timeout = ${previous}`);
    }
}
export function isBusyError(error) {
    const code = error?.code ?? "";
    return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}
//# sourceMappingURL=database.js.map