/**
 * Incremental indexer: re-indexes only changed files.
 * Integrates with file watcher and knowledge extraction.
 */
import { claimWriterLock } from "../indexing/writer-lock.js";
import { extractKnowledge } from "../knowledge/knowledge-extractor.js";
import { summarizeSession, cacheSummary, } from "../knowledge/session-summarizer.js";
import { FileWatcher } from "./file-watcher.js";
/**
 * Live transcripts change every few seconds and the index is 100+ MB, so it is saved
 * at most this often (and when the server stops), not after every change.
 */
export const SAVE_INTERVAL_MS = 5 * 60_000;
export class IncrementalIndexer {
    watcher;
    indexManager;
    knowledgeStore;
    pending = new Set();
    draining = false;
    lastSaveAttempt = 0;
    saveTimer = null;
    constructor(indexManager, knowledgeStore) {
        this.watcher = new FileWatcher();
        this.indexManager = indexManager;
        this.knowledgeStore = knowledgeStore;
    }
    /**
     * Start watching and auto-indexing.
     */
    start() {
        this.watcher.start((filename) => this.enqueue(filename));
    }
    /**
     * Stop watching and write any unsaved changes.
     */
    stop() {
        this.watcher.stop();
        this.pending.clear();
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.saveNow();
    }
    /**
     * Queue a changed file. The native watcher and the poll both report changes, so
     * repeats collapse here and unchanged files are skipped by updateFile's mtime check.
     */
    enqueue(filename) {
        this.pending.add(filename);
        if (this.draining)
            return;
        this.draining = true;
        setImmediate(() => this.drain());
    }
    /** One file per turn of the event loop, so tool calls are still answered while it works. */
    drain() {
        const [next] = this.pending;
        if (next === undefined) {
            this.draining = false;
            this.scheduleSave();
            return;
        }
        this.pending.delete(next);
        try {
            this.handleFileChange(next);
        }
        catch {
            // One unreadable file must not stop the queue
        }
        setImmediate(() => this.drain());
    }
    handleFileChange(filePath) {
        const session = this.indexManager.updateFile(filePath);
        if (!session)
            return;
        const knowledge = extractKnowledge(session);
        for (const entry of knowledge) {
            this.knowledgeStore.addEntry(entry);
        }
        if (knowledge.length > 0) {
            this.knowledgeStore.save();
        }
        cacheSummary(summarizeSession(session));
    }
    /**
     * Save unsaved changes once SAVE_INTERVAL_MS has passed since the last attempt.
     */
    scheduleSave() {
        if (!this.indexManager.isDirty || this.saveTimer)
            return;
        const wait = Math.max(0, this.lastSaveAttempt + SAVE_INTERVAL_MS - Date.now());
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveNow();
        }, wait);
        this.saveTimer.unref();
    }
    saveNow() {
        if (!this.indexManager.isDirty)
            return;
        this.lastSaveAttempt = Date.now();
        if (!claimWriterLock())
            return;
        this.indexManager.save().catch(() => { });
    }
}
//# sourceMappingURL=incremental-indexer.js.map