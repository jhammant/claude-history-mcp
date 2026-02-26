/**
 * Document store: holds indexed document chunks with metadata.
 * Each "document" is a chunk of a conversation session.
 */
export interface DocumentChunk {
    id: number;
    sessionId: string;
    project: string;
    text: string;
    role: "user" | "assistant" | "mixed";
    timestamp: number;
    toolNames: string[];
    tokenCount: number;
    messageIndex: number;
}
export interface DocumentMetadata {
    sessionId: string;
    project: string;
    role: "user" | "assistant" | "mixed";
    timestamp: number;
    toolNames: string[];
    messageIndex: number;
}
export declare class DocumentStore {
    private documents;
    private nextId;
    addDocument(text: string, tokenCount: number, metadata: DocumentMetadata): number;
    getDocument(id: number): DocumentChunk | undefined;
    getDocumentCount(): number;
    getAverageTokenCount(): number;
    getAllDocuments(): DocumentChunk[];
    /**
     * Get documents for a specific session.
     */
    getSessionDocuments(sessionId: string): DocumentChunk[];
    /**
     * Get documents for a specific project.
     */
    getProjectDocuments(project: string): DocumentChunk[];
    /**
     * Remove all documents for a session (for re-indexing).
     */
    removeSession(sessionId: string): void;
    /**
     * Get unique session IDs.
     */
    getSessionIds(): Set<string>;
    /**
     * Get unique project names.
     */
    getProjects(): Set<string>;
    /**
     * Serialize for persistence.
     */
    serialize(): SerializedDocumentStore;
    /**
     * Restore from serialized data.
     */
    static deserialize(data: SerializedDocumentStore): DocumentStore;
}
export interface SerializedDocumentStore {
    documents: DocumentChunk[];
    nextId: number;
}
//# sourceMappingURL=document-store.d.ts.map