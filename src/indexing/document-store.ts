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
  messageIndex: number; // Position within session
}

export interface DocumentMetadata {
  sessionId: string;
  project: string;
  role: "user" | "assistant" | "mixed";
  timestamp: number;
  toolNames: string[];
  messageIndex: number;
}

export class DocumentStore {
  private documents: DocumentChunk[] = [];
  private nextId = 0;

  addDocument(
    text: string,
    tokenCount: number,
    metadata: DocumentMetadata
  ): number {
    const id = this.nextId++;
    this.documents.push({
      id,
      text,
      tokenCount,
      ...metadata,
    });
    return id;
  }

  getDocument(id: number): DocumentChunk | undefined {
    return this.documents[id];
  }

  getDocumentCount(): number {
    return this.documents.length;
  }

  getAverageTokenCount(): number {
    if (this.documents.length === 0) return 0;
    const total = this.documents.reduce((sum, d) => sum + d.tokenCount, 0);
    return total / this.documents.length;
  }

  getAllDocuments(): DocumentChunk[] {
    return this.documents;
  }

  /**
   * Get documents for a specific session.
   */
  getSessionDocuments(sessionId: string): DocumentChunk[] {
    return this.documents.filter((d) => d.sessionId === sessionId);
  }

  /**
   * Get documents for a specific project.
   */
  getProjectDocuments(project: string): DocumentChunk[] {
    return this.documents.filter((d) => d.project === project);
  }

  /**
   * Remove all documents for a session (for re-indexing).
   */
  removeSession(sessionId: string): void {
    this.documents = this.documents.filter((d) => d.sessionId !== sessionId);
  }

  /**
   * Get unique session IDs.
   */
  getSessionIds(): Set<string> {
    return new Set(this.documents.map((d) => d.sessionId));
  }

  /**
   * Get unique project names.
   */
  getProjects(): Set<string> {
    return new Set(this.documents.map((d) => d.project));
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedDocumentStore {
    return {
      documents: this.documents,
      nextId: this.nextId,
    };
  }

  /**
   * Restore from serialized data.
   */
  static deserialize(data: SerializedDocumentStore): DocumentStore {
    const store = new DocumentStore();
    store.documents = data.documents;
    store.nextId = data.nextId;
    return store;
  }
}

export interface SerializedDocumentStore {
  documents: DocumentChunk[];
  nextId: number;
}
