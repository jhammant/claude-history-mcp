import type { DB } from "../db/database.js";
/**
 * Resolved repositories (sessions.repo) a caller's text names: the exact key, part of the
 * repository name (the key's last segment), or the end of the key after a "/" (so
 * "owner/name" finds host/owner/name), case-insensitively.
 */
export declare function matchRepos(db: DB, query: string): string[];
/**
 * Every repository of a project filter as the search engine applies it (a substring of the
 * project dir or working directory), plus the repositories the text names: the sessions of
 * these repositories match the filter too, so it reaches their worktrees and other paths.
 * A session nested in a different repository's tree does not anchor its own repository
 * (see anchoredRepos).
 */
export declare function reposForProjectFilter(db: DB, filter: string): string[];
/**
 * Encoded project dirs matching what a caller typed: a path (exact dir, or dirs beneath
 * it), an encoded dir, part of a name ("ghostty" matches -Users-me-dev-ghostty), or a
 * repository (its key, or part of its name). Then every project that shares a repository
 * with a match, so a repository name or any one of its directories reaches all of its
 * directories and worktrees, on every machine. Except that a match nested in a different
 * repository's tree does not anchor its own repository (see anchoredRepos).
 */
export declare function matchProjects(db: DB, query: string): string[];
/** SQL placeholder list and values for an IN (...) over projects. */
export declare function inList(values: string[]): {
    sql: string;
    params: string[];
};
//# sourceMappingURL=project-match.d.ts.map