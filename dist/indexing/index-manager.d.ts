/**
 * Orchestrate indexing: parse sessions, chunk text, build BM25 + TF-IDF indexes.
 * Handles persistence via msgpack and incremental updates.
 */
import { BM25Index } from "./bm25.js";
import { TFIDFIndex } from "./tfidf.js";
import { DocumentStore } from "./document-store.js";
export interface IndexMeta {
    lastIndexed: Record<string, number>;
    buildTime: number;
    version: number;
}
export declare class IndexManager {
    bm25: BM25Index;
    tfidf: TFIDFIndex;
    documents: DocumentStore;
    private meta;
    constructor();
    /**
     * Build or rebuild the full index from scratch.
     */
    buildFullIndex(): Promise<{
        sessions: number;
        chunks: number;
    }>;
    /**
     * Incrementally update: only re-index files that changed since last index.
     */
    incrementalUpdate(): Promise<{
        added: number;
        updated: number;
        unchanged: number;
    }>;
    /**
     * Index a single session file.
     */
    private indexFile;
    /**
     * Remove a session from all indexes.
     */
    private removeSession;
    /**
     * Chunk a session into indexable pieces.
     * Strategy: group consecutive same-role messages, split long chunks.
     */
    private chunkSession;
    /**
     * Save index to disk using msgpack.
     */
    save(): Promise<void>;
    /**
     * Load index from disk.
     */
    load(): Promise<boolean>;
    private restoreFromSerialized;
    /**
     * Get index statistics.
     */
    getStats(): {
        documents: number;
        sessions: number;
        projects: number;
        vocabulary: number;
        buildTimeMs: number;
    };
}
//# sourceMappingURL=index-manager.d.ts.map