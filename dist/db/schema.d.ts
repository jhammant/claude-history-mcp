/**
 * Schema and migrations. The schema version lives in PRAGMA user_version; each
 * migration runs in its own transaction, in order, exactly once.
 */
import type Database from "better-sqlite3";
export interface Migration {
    version: number;
    description: string;
    up: (db: Database.Database) => void;
}
export declare const MIGRATIONS: Migration[];
/** The FTS `scope` value of a message: its session and role as two tokens. */
export declare function scopeOf(sessionSid: number, role: string): string;
export declare const SCHEMA_VERSION: number;
export declare class SchemaTooNewError extends Error {
    constructor(found: number, supported: number);
}
/** Apply every migration newer than the database's version. Returns the versions applied. */
export declare function migrate(db: Database.Database, migrations?: Migration[]): number[];
//# sourceMappingURL=schema.d.ts.map