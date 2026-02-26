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
export class BM25Index {
    // term -> list of (docId, tf)
    invertedIndex = new Map();
    // docId -> document length (in tokens)
    docLengths = new Map();
    totalDocs = 0;
    totalLength = 0;
    /**
     * Add a document to the index.
     */
    addDocument(docId, tokens) {
        const docLength = tokens.length;
        this.docLengths.set(docId, docLength);
        this.totalDocs++;
        this.totalLength += docLength;
        // Count term frequencies
        const tf = new Map();
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
    removeDocument(docId) {
        const docLength = this.docLengths.get(docId);
        if (docLength === undefined)
            return;
        this.docLengths.delete(docId);
        this.totalDocs--;
        this.totalLength -= docLength;
        // Remove from inverted index
        for (const [term, postings] of this.invertedIndex) {
            const filtered = postings.filter((p) => p.docId !== docId);
            if (filtered.length === 0) {
                this.invertedIndex.delete(term);
            }
            else {
                this.invertedIndex.set(term, filtered);
            }
        }
    }
    /**
     * Search for documents matching query tokens.
     */
    search(queryTokens, limit = 20) {
        if (queryTokens.length === 0 || this.totalDocs === 0)
            return [];
        const avgdl = this.totalLength / this.totalDocs;
        const { k1, b } = CONFIG.bm25;
        const scores = new Map();
        for (const term of queryTokens) {
            const postings = this.invertedIndex.get(term);
            if (!postings)
                continue;
            // IDF: log((N - n + 0.5) / (n + 0.5) + 1)
            const n = postings.length;
            const idf = Math.log((this.totalDocs - n + 0.5) / (n + 0.5) + 1);
            for (const { docId, tf } of postings) {
                const dl = this.docLengths.get(docId) || 0;
                const numerator = tf * (k1 + 1);
                const denominator = tf + k1 * (1 - b + b * (dl / avgdl));
                const termScore = idf * (numerator / denominator);
                scores.set(docId, (scores.get(docId) || 0) + termScore);
            }
        }
        // Sort by score descending
        const results = [];
        for (const [docId, score] of scores) {
            results.push({ docId, score });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }
    /**
     * Get number of indexed documents.
     */
    getDocumentCount() {
        return this.totalDocs;
    }
    /**
     * Get vocabulary size.
     */
    getVocabularySize() {
        return this.invertedIndex.size;
    }
    /**
     * Serialize for persistence.
     */
    serialize() {
        const index = {};
        for (const [term, postings] of this.invertedIndex) {
            index[term] = postings;
        }
        const docLengths = {};
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
    static deserialize(data) {
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
//# sourceMappingURL=bm25.js.map