import type { DB } from "../db/database.js";
/**
 * Encoded project dirs matching what a caller typed: a path (exact dir, or dirs beneath
 * it), an encoded dir, or part of a name ("ghostty" matches -Users-me-dev-ghostty).
 */
export declare function matchProjects(db: DB, query: string): string[];
/** SQL placeholder list and values for an IN (...) over projects. */
export declare function inList(values: string[]): {
    sql: string;
    params: string[];
};
//# sourceMappingURL=project-match.d.ts.map