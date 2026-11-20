/**
 * One-time import of the pre-SQLite store: sessions in index.msgpack whose transcripts
 * are gone (as archived chunk rows), every cached summary and the knowledge file.
 * Idempotent: sessions already in the database, summaries already stored and known
 * knowledge entries are skipped.
 *
 * The old index unpacks to several GB, so run this in its own process with a raised
 * heap limit (the CLI re-launches itself with one) and never beside another heavy job.
 */
import { type DB } from "../db/database.js";
export interface LegacyImportStats {
    chunksInIndex: number;
    sessionsInIndex: number;
    sessionsImported: number;
    rowsImported: number;
    sessionsSkippedOnDisk: number;
    sessionsSkippedExisting: number;
    summariesImported: number;
    knowledgeImported: number;
    ms: number;
}
export declare function importLegacy(db: DB): Promise<LegacyImportStats>;
//# sourceMappingURL=legacy-import.d.ts.map