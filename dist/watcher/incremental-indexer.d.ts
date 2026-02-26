/**
 * Incremental indexer: re-indexes only changed files.
 * Integrates with file watcher and knowledge extraction.
 */
import { IndexManager } from "../indexing/index-manager.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
export declare class IncrementalIndexer {
    private watcher;
    private indexManager;
    private knowledgeStore;
    private processing;
    constructor(indexManager: IndexManager, knowledgeStore: KnowledgeStore);
    /**
     * Start watching and auto-indexing.
     */
    start(): void;
    stop(): void;
    private handleFileChange;
}
//# sourceMappingURL=incremental-indexer.d.ts.map