/**
 * TF-IDF sparse vectors with cosine similarity for semantic recall.
 * Maintains top N terms by document frequency for manageable vector sizes.
 */
export class TFIDFIndex {
    // term -> document frequency (how many docs contain this term)
    df = new Map();
    // docId -> sparse vector (term -> tfidf weight)
    vectors = new Map();
    // docId -> vector magnitude (for cosine similarity)
    magnitudes = new Map();
    totalDocs = 0;
    /**
     * Add a document's tokens to the index.
     */
    addDocument(docId, tokens) {
        this.totalDocs++;
        // Count term frequencies
        const tf = new Map();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }
        // Update document frequencies
        for (const term of tf.keys()) {
            this.df.set(term, (this.df.get(term) || 0) + 1);
        }
        // Compute TF-IDF vector (will be recomputed on search for accuracy)
        // Store raw TF for now
        this.vectors.set(docId, tf);
    }
    /**
     * Remove a document from the index.
     */
    removeDocument(docId) {
        const vector = this.vectors.get(docId);
        if (!vector)
            return;
        // Update document frequencies
        for (const term of vector.keys()) {
            const currentDf = this.df.get(term);
            if (currentDf !== undefined) {
                if (currentDf <= 1) {
                    this.df.delete(term);
                }
                else {
                    this.df.set(term, currentDf - 1);
                }
            }
        }
        this.vectors.delete(docId);
        this.magnitudes.delete(docId);
        this.totalDocs--;
    }
    /**
     * Compute IDF weight for a term.
     */
    idf(term) {
        const docFreq = this.df.get(term);
        if (!docFreq)
            return 0;
        return Math.log(1 + this.totalDocs / docFreq);
    }
    /**
     * Compute TF-IDF vector for query tokens.
     */
    queryVector(queryTokens) {
        const tf = new Map();
        for (const token of queryTokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }
        const vec = new Map();
        for (const [term, freq] of tf) {
            const weight = (1 + Math.log(freq)) * this.idf(term);
            if (weight > 0)
                vec.set(term, weight);
        }
        return vec;
    }
    /**
     * Compute TF-IDF vector for a stored document.
     */
    docVector(docId) {
        const tf = this.vectors.get(docId);
        if (!tf)
            return new Map();
        const vec = new Map();
        for (const [term, freq] of tf) {
            const weight = (1 + Math.log(freq)) * this.idf(term);
            if (weight > 0)
                vec.set(term, weight);
        }
        return vec;
    }
    /**
     * Cosine similarity between two sparse vectors.
     */
    cosineSimilarity(a, b) {
        let dot = 0;
        let magA = 0;
        let magB = 0;
        for (const [term, weightA] of a) {
            magA += weightA * weightA;
            const weightB = b.get(term);
            if (weightB !== undefined) {
                dot += weightA * weightB;
            }
        }
        for (const weightB of b.values()) {
            magB += weightB * weightB;
        }
        if (magA === 0 || magB === 0)
            return 0;
        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }
    /**
     * Search using cosine similarity.
     */
    search(queryTokens, limit = 20) {
        if (queryTokens.length === 0 || this.totalDocs === 0)
            return [];
        const qVec = this.queryVector(queryTokens);
        if (qVec.size === 0)
            return [];
        // Only score documents that share at least one term with the query
        const candidateDocs = new Set();
        for (const term of qVec.keys()) {
            for (const [docId, tf] of this.vectors) {
                if (tf.has(term))
                    candidateDocs.add(docId);
            }
        }
        const results = [];
        for (const docId of candidateDocs) {
            const dVec = this.docVector(docId);
            const score = this.cosineSimilarity(qVec, dVec);
            if (score > 0) {
                results.push({ docId, score });
            }
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }
    getDocumentCount() {
        return this.totalDocs;
    }
    getVocabularySize() {
        return this.df.size;
    }
    /**
     * Serialize for persistence.
     */
    serialize() {
        const df = {};
        for (const [term, freq] of this.df) {
            df[term] = freq;
        }
        const vectors = {};
        for (const [docId, vec] of this.vectors) {
            const obj = {};
            for (const [term, weight] of vec) {
                obj[term] = weight;
            }
            vectors[docId] = obj;
        }
        return { df, vectors, totalDocs: this.totalDocs };
    }
    /**
     * Restore from serialized data.
     */
    static deserialize(data) {
        const index = new TFIDFIndex();
        for (const [term, freq] of Object.entries(data.df)) {
            index.df.set(term, freq);
        }
        for (const [docIdStr, vecObj] of Object.entries(data.vectors)) {
            const vec = new Map();
            for (const [term, weight] of Object.entries(vecObj)) {
                vec.set(term, weight);
            }
            index.vectors.set(Number(docIdStr), vec);
        }
        index.totalDocs = data.totalDocs;
        return index;
    }
}
//# sourceMappingURL=tfidf.js.map