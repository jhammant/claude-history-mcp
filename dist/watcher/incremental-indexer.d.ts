/**
 * Incremental indexer: re-indexes only changed files.
 * Integrates with file watcher and knowledge extraction.
 */
import { IndexManager } from "../indexing/index-manager.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
/**
 * Live transcripts change every few seconds and the index is 100+ MB, so it is saved
 * at most this often (and when the server stops), not after every change.
 */
export declare const SAVE_INTERVAL_MS: number;
export declare class IncrementalIndexer {
    private watcher;
    private indexManager;
    private knowledgeStore;
    private pending;
    private draining;
    private lastSaveAttempt;
    private saveTimer;
    constructor(indexManager: IndexManager, knowledgeStore: KnowledgeStore);
    /**
     * Start watching and auto-indexing.
     */
    start(): void;
    /**
     * Stop watching and write any unsaved changes.
     */
    stop(): void;
    /**
     * Queue a changed file. The native watcher and the poll both report changes, so
     * repeats collapse here and unchanged files are skipped by updateFile's mtime check.
     */
    enqueue(filename: string): void;
    /** One file per turn of the event loop, so tool calls are still answered while it works. */
    private drain;
    private handleFileChange;
    /**
     * Save unsaved changes once SAVE_INTERVAL_MS has passed since the last attempt.
     */
    scheduleSave(): void;
    private saveNow;
}
//# sourceMappingURL=incremental-indexer.d.ts.map