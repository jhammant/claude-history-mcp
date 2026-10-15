/**
 * Incremental indexer: re-indexes only changed files.
 * Integrates with file watcher and knowledge extraction.
 */
import { basename, dirname } from "path";
import { statSync } from "fs";
import { parseSessionFile } from "../parsers/session-parser.js";
import { extractKnowledge } from "../knowledge/knowledge-extractor.js";
import { summarizeSession, cacheSummary, } from "../knowledge/session-summarizer.js";
import { FileWatcher } from "./file-watcher.js";
export class IncrementalIndexer {
    watcher;
    indexManager;
    knowledgeStore;
    processing = new Set();
    constructor(indexManager, knowledgeStore) {
        this.watcher = new FileWatcher();
        this.indexManager = indexManager;
        this.knowledgeStore = knowledgeStore;
    }
    /**
     * Start watching and auto-indexing.
     */
    start() {
        this.watcher.start((filename) => {
            this.handleFileChange(filename).catch(() => { });
        });
    }
    stop() {
        this.watcher.stop();
    }
    async handleFileChange(filename) {
        if (this.processing.has(filename))
            return;
        this.processing.add(filename);
        try {
            const projectDir = basename(dirname(filename));
            const filePath = filename;
            let stat;
            try {
                stat = statSync(filePath);
            }
            catch {
                return;
            }
            // The watcher already debounces writes. A five-minute freshness veto
            // permanently lost final updates because it never scheduled a retry.
            // Re-index this file
            await this.indexManager.incrementalUpdate();
            await this.indexManager.save();
            // Extract knowledge from the session
            const session = parseSessionFile(filePath, projectDir);
            if (session) {
                const knowledge = extractKnowledge(session);
                for (const entry of knowledge) {
                    this.knowledgeStore.addEntry(entry);
                }
                if (knowledge.length > 0) {
                    this.knowledgeStore.save();
                }
                // Cache summary
                const summary = summarizeSession(session);
                cacheSummary(summary);
            }
        }
        finally {
            this.processing.delete(filename);
        }
    }
}
//# sourceMappingURL=incremental-indexer.js.map