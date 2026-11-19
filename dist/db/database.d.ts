/**
 * Opening the shared history database. Every process (servers, the sweep, the hook)
 * opens the same file; WAL lets readers run while one writer commits.
 */
import Database from "better-sqlite3";
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
export declare class DatabaseOutdatedError extends Error {
    readonly path: string;
    readonly found: number;
    constructor(path: string, found: number);
}
export declare class DatabaseMissingError extends Error {
    readonly path: string;
    constructor(path: string);
}
export declare function openDatabase(path: string, options?: OpenOptions): DB;
export declare function getMeta(db: DB, key: string): string | undefined;
export declare function setMeta(db: DB, key: string, value: string): void;
/** Run `fn` with the connection's busy timeout temporarily set to `ms`. */
export declare function withBusyTimeout<T>(db: DB, ms: number, fn: () => T): T;
export declare function isBusyError(error: unknown): boolean;
//# sourceMappingURL=database.d.ts.map