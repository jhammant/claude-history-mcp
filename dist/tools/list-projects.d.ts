import type { DB } from "../db/database.js";
/**
 * Projects with history, newest first by default. Capped, because a long-lived database
 * holds hundreds of projects and the caller is a model with a context budget. Sessions with
 * no messages (empty Codex guardian-review threads) are left out of the rows and their counts.
 */
export declare function handleListProjects(db: DB, args: {
    sort_by?: string;
    limit?: number;
    query?: string;
}): string;
//# sourceMappingURL=list-projects.d.ts.map