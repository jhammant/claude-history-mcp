/**
 * Persist and query extracted knowledge entries.
 */
export interface KnowledgeEntry {
    id: string;
    type: "decision" | "solution" | "error_fix" | "pattern";
    project: string;
    sessionId: string;
    timestamp: number;
    summary: string;
    details: string;
    tags: string[];
    relatedFiles: string[];
}
export declare class KnowledgeStore {
    private entries;
    addEntry(entry: KnowledgeEntry): void;
    /**
     * Find entries matching a query.
     */
    search(query: string, project?: string): KnowledgeEntry[];
    /**
     * Get entries for a project.
     */
    getProjectEntries(project: string): KnowledgeEntry[];
    /**
     * Get entries by type.
     */
    getByType(type: KnowledgeEntry["type"], project?: string): KnowledgeEntry[];
    /**
     * Save to disk.
     */
    save(): void;
    /**
     * Load from disk.
     */
    load(): boolean;
    getEntryCount(): number;
}
//# sourceMappingURL=knowledge-store.d.ts.map