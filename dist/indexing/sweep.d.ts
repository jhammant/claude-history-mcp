/**
 * Keeping the database fresh: the full sweep (run by a scheduled job) and the small,
 * time-boxed top-up a server may do before answering a search.
 */
import { type DB } from "../db/database.js";
import { type TranscriptFile } from "../parsers/transcript-files.js";
import { type DuplicateLines } from "./indexer.js";
import { type LineHolder } from "./line-keys.js";
/** Transcripts whose size, mtime or inode differ from what was last indexed. */
export declare function changedTranscripts(db: DB): {
    all: number;
    changed: TranscriptFile[];
    files: TranscriptFile[];
};
export interface LockHolder {
    pid: number;
    acquired: number;
}
/** Take a named lock in the database. Returns the live holder when someone else has it. */
export declare function acquireLock(db: DB, name: string): LockHolder | null;
export declare function releaseLock(db: DB, name: string): void;
export declare class SweepBusyError extends Error {
    readonly holder: LockHolder;
    constructor(holder: LockHolder);
}
export interface SweepStats {
    transcripts: number;
    changed: number;
    indexed: number;
    reset: number;
    raced: number;
    vanished: number;
    messagesAdded: number;
    bytesRead: number;
    summarized: number;
    optimized: boolean;
    vacuumed: boolean;
    sessions: number;
    messages: number;
    databaseBytes: number;
    /** Claude lines skipped because their uuid was already indexed, by class. */
    duplicates: DuplicateLines;
    /** Set when the repository step failed; the rest of the sweep is unaffected. */
    repoError?: string;
    ms: number;
}
export interface SweepOptions {
    /** Called with a short progress line now and then (for a terminal). */
    progress?: (line: string) => void;
    /**
     * Which session holds a Claude line now, to break exact ties in the indexing order (rebuild
     * passes the database it replaces, so a tie keeps its owner). See line-keys.ts.
     */
    lineHolder?: LineHolder;
    /** Ask git about the working directories of the sessions indexed (default true; false for tests with no real repository). */
    probeRepos?: boolean;
}
/** Count new messages towards the next VACUUM. */
export declare function noteNewMessages(db: DB, added: number): void;
export declare function sweep(db: DB, options?: SweepOptions): SweepStats;
export interface TopUpResult {
    /** Transcripts brought fully up to date. */
    indexed: number;
    /** Changed transcripts still not (fully) indexed. */
    behind: number;
    ms: number;
}
/**
 * Index transcripts changed since the last sweep, newest first, until the budget is
 * spent. Cheap to call: it stats top-level files only, and walks subagent directories
 * only of sessions whose own transcript changed.
 */
export declare function topUp(db: DB, budgetMs?: number): TopUpResult;
//# sourceMappingURL=sweep.d.ts.map