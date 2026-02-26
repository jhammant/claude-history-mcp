/**
 * TF-IDF sparse vectors with cosine similarity for semantic recall.
 * Maintains top N terms by document frequency for manageable vector sizes.
 */
export interface TFIDFSearchResult {
    docId: number;
    score: number;
}
export declare class TFIDFIndex {
    private df;
    private vectors;
    private magnitudes;
    private totalDocs;
    /**
     * Add a document's tokens to the index.
     */
    addDocument(docId: number, tokens: string[]): void;
    /**
     * Remove a document from the index.
     */
    removeDocument(docId: number): void;
    /**
     * Compute IDF weight for a term.
     */
    private idf;
    /**
     * Compute TF-IDF vector for query tokens.
     */
    private queryVector;
    /**
     * Compute TF-IDF vector for a stored document.
     */
    private docVector;
    /**
     * Cosine similarity between two sparse vectors.
     */
    private cosineSimilarity;
    /**
     * Search using cosine similarity.
     */
    search(queryTokens: string[], limit?: number): TFIDFSearchResult[];
    getDocumentCount(): number;
    getVocabularySize(): number;
    /**
     * Serialize for persistence.
     */
    serialize(): SerializedTFIDF;
    /**
     * Restore from serialized data.
     */
    static deserialize(data: SerializedTFIDF): TFIDFIndex;
}
export interface SerializedTFIDF {
    df: Record<string, number>;
    vectors: Record<number, Record<string, number>>;
    totalDocs: number;
}
//# sourceMappingURL=tfidf.d.ts.map