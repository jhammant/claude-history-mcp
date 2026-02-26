/**
 * Okapi BM25 inverted index for keyword search.
 *
 * BM25 scoring formula:
 *   score(D,Q) = Σ IDF(qi) * (f(qi,D) * (k1 + 1)) / (f(qi,D) + k1 * (1 - b + b * |D|/avgdl))
 *
 * Where:
 *   f(qi,D) = term frequency of qi in document D
 *   |D| = length of document D in tokens
 *   avgdl = average document length
 *   k1 = 1.2 (term frequency saturation)
 *   b = 0.75 (document length normalization)
 */

import { CONFIG } from "../config.js";

export interface BM25SearchResult {
  docId: number;
  score: number;
}

interface PostingEntry {
  docId: number;
  tf: number; // term frequency in this document
}

export class BM25Index {
  // term -> list of (docId, tf)
  private invertedIndex = new Map<string, PostingEntry[]>();
  // docId -> document length (in tokens)
  private docLengths = new Map<number, number>();
  private totalDocs = 0;
  private totalLength = 0;

  /**
   * Add a document to the index.
   */
  addDocument(docId: number, tokens: string[]): void {
    const docLength = tokens.length;
    this.docLengths.set(docId, docLength);
    this.totalDocs++;
    this.totalLength += docLength;

    // Count term frequencies
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Add to inverted index
    for (const [term, freq] of tf) {
      let postings = this.invertedIndex.get(term);
      if (!postings) {
        postings = [];
        this.invertedIndex.set(term, postings);
      }
      postings.push({ docId, tf: freq });
    }
  }

  /**
   * Remove a document from the index.
   */
  removeDocument(docId: number): void {
    const docLength = this.docLengths.get(docId);
    if (docLength === undefined) return;

    this.docLengths.delete(docId);
    this.totalDocs--;
    this.totalLength -= docLength;

    // Remove from inverted index
    for (const [term, postings] of this.invertedIndex) {
      const filtered = postings.filter((p) => p.docId !== docId);
      if (filtered.length === 0) {
        this.invertedIndex.delete(term);
      } else {
        this.invertedIndex.set(term, filtered);
      }
    }
  }

  /**
   * Search for documents matching query tokens.
   */
  search(queryTokens: string[], limit = 20): BM25SearchResult[] {
    if (queryTokens.length === 0 || this.totalDocs === 0) return [];

    const avgdl = this.totalLength / this.totalDocs;
    const { k1, b } = CONFIG.bm25;
    const scores = new Map<number, number>();

    for (const term of queryTokens) {
      const postings = this.invertedIndex.get(term);
      if (!postings) continue;

      // IDF: log((N - n + 0.5) / (n + 0.5) + 1)
      const n = postings.length;
      const idf = Math.log(
        (this.totalDocs - n + 0.5) / (n + 0.5) + 1
      );

      for (const { docId, tf } of postings) {
        const dl = this.docLengths.get(docId) || 0;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (dl / avgdl));
        const termScore = idf * (numerator / denominator);

        scores.set(docId, (scores.get(docId) || 0) + termScore);
      }
    }

    // Sort by score descending
    const results: BM25SearchResult[] = [];
    for (const [docId, score] of scores) {
      results.push({ docId, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Get number of indexed documents.
   */
  getDocumentCount(): number {
    return this.totalDocs;
  }

  /**
   * Get vocabulary size.
   */
  getVocabularySize(): number {
    return this.invertedIndex.size;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedBM25 {
    const index: Record<string, PostingEntry[]> = {};
    for (const [term, postings] of this.invertedIndex) {
      index[term] = postings;
    }
    const docLengths: Record<number, number> = {};
    for (const [docId, length] of this.docLengths) {
      docLengths[docId] = length;
    }
    return {
      index,
      docLengths,
      totalDocs: this.totalDocs,
      totalLength: this.totalLength,
    };
  }

  /**
   * Restore from serialized data.
   */
  static deserialize(data: SerializedBM25): BM25Index {
    const bm25 = new BM25Index();
    for (const [term, postings] of Object.entries(data.index)) {
      bm25.invertedIndex.set(term, postings);
    }
    for (const [docId, length] of Object.entries(data.docLengths)) {
      bm25.docLengths.set(Number(docId), length);
    }
    bm25.totalDocs = data.totalDocs;
    bm25.totalLength = data.totalLength;
    return bm25;
  }
}

export interface SerializedBM25 {
  index: Record<string, PostingEntry[]>;
  docLengths: Record<number, number>;
  totalDocs: number;
  totalLength: number;
}
