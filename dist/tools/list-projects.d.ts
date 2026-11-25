import type { DB } from "../db/database.js";
/**
 * Projects with history, one row per repository (sessions with no resolved repository are
 * grouped by project dir), newest first by default. A row is named by the repository's name,
 * never its remote URL, and lists its directories. Capped, because a long-lived database
 * holds hundreds of projects and the caller is a model with a context budget. Codex and pi sessions with no
 * messages (empty Codex guardian-review threads) are left out of the rows and their counts; every Claude session is counted.
 */
export declare function handleListProjects(db: DB, args: {
    sort_by?: string;
    limit?: number;
    query?: string;
}): string;
//# sourceMappingURL=list-projects.d.ts.map