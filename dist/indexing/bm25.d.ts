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
export interface BM25SearchResult {
    docId: number;
    score: number;
}
interface PostingEntry {
    docId: number;
    tf: number;
}
export declare class BM25Index {
    private invertedIndex;
    private docLengths;
    private totalDocs;
    private totalLength;
    /**
     * Add a document to the index.
     */
    addDocument(docId: number, tokens: string[]): void;
    /**
     * Remove a document from the index.
     */
    removeDocument(docId: number): void;
    /**
     * Search for documents matching query tokens.
     */
    search(queryTokens: string[], limit?: number): BM25SearchResult[];
    /**
     * Get number of indexed documents.
     */
    getDocumentCount(): number;
    /**
     * Get vocabulary size.
     */
    getVocabularySize(): number;
    /**
     * Serialize for persistence.
     */
    serialize(): SerializedBM25;
    /**
     * Restore from serialized data.
     */
    static deserialize(data: SerializedBM25): BM25Index;
}
export interface SerializedBM25 {
    index: Record<string, PostingEntry[]>;
    docLengths: Record<number, number>;
    totalDocs: number;
    totalLength: number;
}
export {};
//# sourceMappingURL=bm25.d.ts.map