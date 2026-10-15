/**
 * Orchestrate indexing: parse sessions, chunk text, build BM25 + TF-IDF indexes.
 * Handles persistence via msgpack and incremental updates.
 */
import { type ParsedSession } from "../parsers/session-parser.js";
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
    private dirty;
    /** True when the in-memory index has changes that are not on disk yet. */
    get isDirty(): boolean;
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
     * Re-index one session file if it changed since it was last indexed. Returns the
     * parsed session when it was re-indexed (so callers can reuse it), else null.
     */
    updateFile(filePath: string): ParsedSession | null;
    /** Drop the in-memory index (it can be several GB); load() brings it back. */
    unload(): void;
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
     * Save index to disk using msgpack (JSON if msgpack fails).
     */
    save(): Promise<void>;
    /**
     * Load index from disk: the newer of the msgpack and JSON files, so a stale file in
     * one format never shadows a fresh one in the other.
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