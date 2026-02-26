/**
 * Hybrid search engine: BM25 + TF-IDF + Reciprocal Rank Fusion.
 */
import { IndexManager } from "../indexing/index-manager.js";
export interface SearchResult {
    sessionId: string;
    project: string;
    text: string;
    score: number;
    timestamp: number;
    toolNames: string[];
    role: "user" | "assistant" | "mixed";
}
export interface SearchOptions {
    limit?: number;
    project?: string;
    currentProject?: string;
    includeContext?: boolean;
}
export declare class SearchEngine {
    private indexManager;
    constructor(indexManager: IndexManager);
    /**
     * Search conversations with hybrid BM25 + TF-IDF.
     */
    search(rawQuery: string, options?: SearchOptions): SearchResult[];
    /**
     * Search specifically for error/solution patterns.
     */
    searchSolutions(errorOrProblem: string, technology?: string): SearchResult[];
}
//# sourceMappingURL=search-engine.d.ts.map