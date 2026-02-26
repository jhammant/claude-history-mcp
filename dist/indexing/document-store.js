/**
 * Document store: holds indexed document chunks with metadata.
 * Each "document" is a chunk of a conversation session.
 */
export class DocumentStore {
    documents = [];
    nextId = 0;
    addDocument(text, tokenCount, metadata) {
        const id = this.nextId++;
        this.documents.push({
            id,
            text,
            tokenCount,
            ...metadata,
        });
        return id;
    }
    getDocument(id) {
        return this.documents[id];
    }
    getDocumentCount() {
        return this.documents.length;
    }
    getAverageTokenCount() {
        if (this.documents.length === 0)
            return 0;
        const total = this.documents.reduce((sum, d) => sum + d.tokenCount, 0);
        return total / this.documents.length;
    }
    getAllDocuments() {
        return this.documents;
    }
    /**
     * Get documents for a specific session.
     */
    getSessionDocuments(sessionId) {
        return this.documents.filter((d) => d.sessionId === sessionId);
    }
    /**
     * Get documents for a specific project.
     */
    getProjectDocuments(project) {
        return this.documents.filter((d) => d.project === project);
    }
    /**
     * Remove all documents for a session (for re-indexing).
     */
    removeSession(sessionId) {
        this.documents = this.documents.filter((d) => d.sessionId !== sessionId);
    }
    /**
     * Get unique session IDs.
     */
    getSessionIds() {
        return new Set(this.documents.map((d) => d.sessionId));
    }
    /**
     * Get unique project names.
     */
    getProjects() {
        return new Set(this.documents.map((d) => d.project));
    }
    /**
     * Serialize for persistence.
     */
    serialize() {
        return {
            documents: this.documents,
            nextId: this.nextId,
        };
    }
    /**
     * Restore from serialized data.
     */
    static deserialize(data) {
        const store = new DocumentStore();
        store.documents = data.documents;
        store.nextId = data.nextId;
        return store;
    }
}
//# sourceMappingURL=document-store.js.map