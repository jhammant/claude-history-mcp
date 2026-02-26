/**
 * Hybrid search engine: BM25 + TF-IDF + Reciprocal Rank Fusion.
 */

import { IndexManager } from "../indexing/index-manager.js";
import { tokenize } from "../indexing/tokenizer.js";
import { parseQuery, type ParsedQuery, type QueryFilters } from "./query-processor.js";
import {
  reciprocalRankFusion,
  applyBoosts,
  applyFilters,
  type RankedResult,
} from "./result-ranker.js";

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

export class SearchEngine {
  constructor(private indexManager: IndexManager) {}

  /**
   * Search conversations with hybrid BM25 + TF-IDF.
   */
  search(rawQuery: string, options: SearchOptions = {}): SearchResult[] {
    const { text, filters } = parseQuery(rawQuery);

    // Merge explicit project option into filters
    if (options.project && !filters.project) {
      filters.project = options.project;
    }

    const limit = Math.min(options.limit || 20, 100);
    const tokens = tokenize(text, { includeBigrams: true });

    if (tokens.length === 0) return [];

    // Get BM25 results
    const bm25Results = this.indexManager.bm25.search(tokens, limit * 3);

    // Get TF-IDF results
    const tfidfResults = this.indexManager.tfidf.search(tokens, limit * 3);

    // Fuse rankings
    const fusedScores = reciprocalRankFusion(bm25Results, tfidfResults);

    // Build ranked results with document data
    const ranked: RankedResult[] = [];
    for (const [docId, score] of fusedScores) {
      const doc = this.indexManager.documents.getDocument(docId);
      if (doc) {
        ranked.push({ docId, score, doc });
      }
    }

    // Apply filters
    const filtered = applyFilters(ranked, filters);

    // Apply boosts and dedup
    const boosted = applyBoosts(filtered, filters, options.currentProject);

    // Convert to search results
    return boosted.slice(0, limit).map((r) => ({
      sessionId: r.doc.sessionId,
      project: r.doc.project,
      text: r.doc.text,
      score: r.score,
      timestamp: r.doc.timestamp,
      toolNames: r.doc.toolNames,
      role: r.doc.role,
    }));
  }

  /**
   * Search specifically for error/solution patterns.
   */
  searchSolutions(
    errorOrProblem: string,
    technology?: string
  ): SearchResult[] {
    // Augment query with solution-related terms
    let query = errorOrProblem;
    if (technology) {
      query = `${technology} ${query}`;
    }

    // Search with higher limit to find solution patterns
    const results = this.search(query, { limit: 50 });

    // Prefer results that contain solution indicators
    const solutionWords = [
      "fixed",
      "solved",
      "solution",
      "resolved",
      "issue was",
      "the problem",
      "worked",
      "working now",
    ];

    return results
      .map((r) => {
        const textLower = r.text.toLowerCase();
        const hasSolutionIndicator = solutionWords.some((w) =>
          textLower.includes(w)
        );
        return {
          ...r,
          score: hasSolutionIndicator ? r.score * 1.5 : r.score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }
}
