import { isPathKey, repoName } from "../repos/resolve.js";
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
const trimRoot = (p) => p.replace(/\/+$/, "");
/**
 * The repositories whose sessions a project filter expands to. Each directly matched
 * session anchors its repository (all of that repository's sessions then match too), unless
 * it sits inside a different repository that the filter is about. It then does not anchor,
 * and still matches directly. A session does not anchor when all of these hold:
 *   1. it has a working directory;
 *   2. its own repository root does not match the filter;
 *   3. another repository on the same machine, known by a remote, has a root that matches
 *      the filter, and the working directory is that root or beneath it (segment-aware).
 * A repository known only by its path (a plain folder) never contains another, so a
 * symlinked repository under a parent folder still anchors. The cost: a worktree nested in a
 * repository with no remote still expands.
 * A root matches the filter when it, or its encoded form (-home-me-dev-app, with '/' or any
 * character outside [A-Za-z0-9] as '-'), contains the filter text, case-insensitively. So a worktree of one repository inside another's tree
 * does not drag in the first repository, while a symlinked path, or a folder holding several
 * repositories, still reaches every repository it names.
 */
function anchoredRepos(db, filter, direct) {
    const f = trimRoot(filter.trim()).toLowerCase();
    const matches = (root) => root.toLowerCase().includes(f) ||
        encodeProjectPath(root).toLowerCase().includes(f) ||
        root.replace(/[^A-Za-z0-9]/g, "-").toLowerCase().includes(f);
    const triples = db
        .prepare("SELECT DISTINCT host, repo, repo_root FROM sessions WHERE repo IS NOT NULL AND repo_root IS NOT NULL")
        .all();
    const matching = triples.filter((t) => matches(t.repo_root) && !isPathKey(t.host, t.repo, t.repo_root));
    const anchored = new Set();
    for (const s of direct) {
        if (s.repo === null)
            continue;
        const cwd = s.cwd === null ? null : trimRoot(s.cwd);
        const nested = cwd !== null &&
            !(s.repo_root !== null && matches(s.repo_root)) &&
            matching.some((a) => {
                if (a.host !== s.host || a.repo === s.repo)
                    return false;
                const root = trimRoot(a.repo_root);
                return cwd === root || cwd.startsWith(root + "/");
            });
        if (!nested)
            anchored.add(s.repo);
    }
    return [...anchored];
}
/**
 * Every repository of a project filter as the search engine applies it (a substring of the
 * project dir or working directory), plus the repositories the text names: the sessions of
 * these repositories match the filter too, so it reaches their worktrees and other paths.
 * A session nested in a different repository's tree does not anchor its own repository
 * (see anchoredRepos).
 */
export function reposForProjectFilter(db, filter) {
    const like = `%${likeEscape(filter)}%`;
    const direct = db
        .prepare("SELECT DISTINCT host, repo, repo_root, cwd FROM sessions WHERE repo IS NOT NULL AND (project LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')")
        .all(like, like);
    return [...new Set([...anchoredRepos(db, filter, direct), ...matchRepos(db, filter)])];
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
 * directories and worktrees, on every machine. Except that a match nested in a different
 * repository's tree does not anchor its own repository (see anchoredRepos).
 */
export function matchProjects(db, query) {
    const q = query.trim();
    if (!q)
        return [];
    const direct = directProjects(db, q);
    const repos = new Set(matchRepos(db, q));
    if (direct.length) {
        const placed = db
            .prepare("SELECT DISTINCT host, repo, repo_root, cwd FROM sessions WHERE repo IS NOT NULL AND project IN (SELECT value FROM json_each(?))")
            .all(JSON.stringify(direct));
        for (const r of anchoredRepos(db, q, placed))
            repos.add(r);
    }
    return [...new Set([...direct, ...projectsOfRepos(db, [...repos])])];
}
/** SQL placeholder list and values for an IN (...) over projects. */
export function inList(values) {
    return { sql: values.map(() => "?").join(", "), params: values };
}
//# sourceMappingURL=project-match.js.map