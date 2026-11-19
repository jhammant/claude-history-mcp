/**
 * Extracted knowledge (decisions, solutions, error fixes) in the database.
 */
import type { DB } from "../db/database.js";
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
/**
 * Insert entries, skipping any whose (project, type, summary) is already known —
 * the same de-duplication the JSON store did.
 */
export declare function insertKnowledge(db: DB, entries: Array<Omit<KnowledgeEntry, "id">>): number;
/** Replace what was extracted from one session (it is re-extracted as the session grows). */
export declare function replaceSessionKnowledge(db: DB, sessionId: string, entries: Array<Omit<KnowledgeEntry, "id">>): void;
/** Entries for a project (exact encoded dir, or a dir beneath it), newest first. */
export declare function projectKnowledge(db: DB, project: string, type: KnowledgeEntry["type"], limit: number): KnowledgeEntry[];
/** Entries whose summary mentions any of the words, newest first. */
export declare function searchKnowledge(db: DB, words: string[], limit: number, types?: KnowledgeEntry["type"][]): KnowledgeEntry[];
//# sourceMappingURL=knowledge-store.d.ts.map