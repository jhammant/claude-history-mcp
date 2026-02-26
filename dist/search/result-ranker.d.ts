/**
 * Score fusion using Reciprocal Rank Fusion (RRF), plus recency and project boosts.
 */
import type { DocumentChunk } from "../indexing/document-store.js";
import type { QueryFilters } from "./query-processor.js";
export interface RankedResult {
    docId: number;
    score: number;
    doc: DocumentChunk;
}
interface RankEntry {
    docId: number;
    score: number;
}
/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * RRF(d) = Σ 1 / (k + rank_i(d))
 */
export declare function reciprocalRankFusion(...rankedLists: RankEntry[][]): Map<number, number>;
/**
 * Apply post-retrieval boosts: recency, project match, deduplication.
 */
export declare function applyBoosts(results: RankedResult[], filters: QueryFilters, currentProject?: string): RankedResult[];
/**
 * Apply query filters to results.
 */
export declare function applyFilters(results: RankedResult[], filters: QueryFilters): RankedResult[];
export {};
//# sourceMappingURL=result-ranker.d.ts.map