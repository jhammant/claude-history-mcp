import { repoName } from "../repos/resolve.js";
import { encodeProjectPath } from "../utils/path-encoder.js";
function likeEscape(value) {
    return value.replace(/[\\%_]/g, (c) => "\\" + c);
}
/**
 * Resolved repositories (sessions.repo) a caller's text names: the exact key, or part of the
 * repository name (the key's last segment), case-insensitively.
 */
export function matchRepos(db, query) {
    const q = query.trim().replace(/\/+$/, "");
    if (!q)
        return [];
    const lower = q.toLowerCase();
    const repos = db.prepare("SELECT DISTINCT repo FROM sessions WHERE repo IS NOT NULL").pluck().all();
    return repos.filter((r) => r === q || repoName(r).toLowerCase().includes(lower));
}
/**
 * Every repository of a project filter as the search engine applies it (a substring of the
 * project dir or working directory), plus the repositories the text names: the sessions of
 * these repositories match the filter too, so it reaches their worktrees and other paths.
 */
export function reposForProjectFilter(db, filter) {
    const like = `%${likeEscape(filter)}%`;
    const viaSessions = db
        .prepare("SELECT DISTINCT repo FROM sessions WHERE repo IS NOT NULL AND (project LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')")
        .pluck()
        .all(like, like);
    return [...new Set([...viaSessions, ...matchRepos(db, filter)])];
}
/** Every project with a session in one of these repositories. */
function projectsOfRepos(db, repos) {
    if (repos.length === 0)
        return [];
    return db
        .prepare("SELECT DISTINCT project FROM sessions WHERE repo IN (SELECT value FROM json_each(?))")
        .pluck()
        .all(JSON.stringify(repos));
}
/** Projects matching what a caller typed by directory: a path, an encoded dir, or part of a name. */
function directProjects(db, q) {
    const encoded = q.includes("/") ? encodeProjectPath(q.replace(/\/+$/, "")) : q;
    const exact = db
        .prepare("SELECT DISTINCT project FROM sessions WHERE project >= ? AND project < ?")
        .all(encoded, encoded + "￿");
    if (exact.length)
        return exact.map((r) => r.project);
    const like = `%${likeEscape(q)}%`;
    const rows = db
        .prepare("SELECT DISTINCT project FROM sessions WHERE project LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\'")
        .all(like, like);
    return rows.map((r) => r.project);
}
/**
 * Encoded project dirs matching what a caller typed: a path (exact dir, or dirs beneath
 * it), an encoded dir, part of a name ("ghostty" matches -Users-me-dev-ghostty), or a
 * repository (its key, or part of its name). Then every project that shares a repository
 * with a match, so a repository name or any one of its directories reaches all of its
 * directories and worktrees, on every machine.
 */
export function matchProjects(db, query) {
    const q = query.trim();
    if (!q)
        return [];
    const direct = directProjects(db, q);
    const repos = new Set(matchRepos(db, q));
    if (direct.length) {
        const own = db
            .prepare("SELECT DISTINCT repo FROM sessions WHERE repo IS NOT NULL AND project IN (SELECT value FROM json_each(?))")
            .pluck()
            .all(JSON.stringify(direct));
        for (const r of own)
            repos.add(r);
    }
    return [...new Set([...direct, ...projectsOfRepos(db, [...repos])])];
}
/** SQL placeholder list and values for an IN (...) over projects. */
export function inList(values) {
    return { sql: values.map(() => "?").join(", "), params: values };
}
//# sourceMappingURL=project-match.js.map