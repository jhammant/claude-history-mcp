/**
 * Which repository a session belongs to. Four facts, in order of trust: the session's own
 * git remote when it was seen at the session's cwd (Codex records one), the pushed directory
 * map, the remote of another session that ran at exactly the same directory with git evidence
 * there (an implicit map row), and path patterns for well-known worktree layouts; the working
 * directory itself is the last resort. A session remote seen at another directory ranks below
 * the map: it is used only when no map row names the cwd.
 *
 * Every fact but a remote is scoped by host: a path names a directory on one machine, so the
 * same path on two machines is never assumed to be the same repository. A repository with a
 * remote is keyed `host/owner/name` (the remote's host) and is the same on every machine; one
 * without is keyed `<host>:<path>` (see pathKey).
 */
import { createHash } from "crypto";
import { CONFIG } from "../config.js";
import { hostAliasesFromEnv, normaliseRemote } from "./url.js";
function trimSlash(path) {
    return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Pattern folding to the repository directory (anything below the worktree is dropped):
 *
 *   R1  `<repo>/.claude/worktrees/<n>[/...]`: always `<repo>`
 *   R2  `<dir>/<c>/<n>[/...]` for each container name `c` (CLAUDE_HISTORY_WORKTREE_DIRS,
 *       default `.worktrees` and `worktrees`): `<dir>` only when `isRepoDir(<dir>)` gives
 *       strong evidence that it is a git work tree (see repoEvidence); a folder holding many
 *       repositories keeps its own worktree folder there too. No names, no R2.
 *   R4  otherwise the path itself
 *
 * (R0, the pushed map, is applied by the resolver before this.)
 */
export function foldWorktreePath(cwd, isRepoDir, containers = CONFIG.worktreeDirs) {
    const path = trimSlash(cwd);
    const claude = /^(.+?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/.exec(path);
    if (claude)
        return claude[1];
    if (containers.length === 0 || !isRepoDir)
        return path;
    const names = containers.map(escapeRegExp).join("|");
    const worktree = new RegExp(`^(.+?)\\/(?:${names})\\/[^/]+(?:\\/.*)?$`).exec(path);
    if (worktree && isRepoDir(worktree[1]))
        return worktree[1];
    return path;
}
/** The key of a repository known only by its path: `<host>:<path>`, or the plain path when host is unknown (''). */
export function pathKey(host, path) {
    return host === "" ? path : `${host}:${path}`;
}
/** The last path segment: a repository key's name, a directory's base name. */
export function lastSegment(path) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}
/**
 * The display name of a repository key: the last segment of the remote (`host/owner/name`) or
 * of the path in a path key. A path key's `<host>:` prefix is never part of the name, even when
 * the path has no segment of its own (the filesystem root).
 */
export function repoName(key) {
    return lastSegment(key.replace(/^[^/]*:(?=\/)/, ""));
}
/**
 * The one test of strong evidence that a directory is a git work tree: the host's pushed map
 * names it, or a session of the host that ran in it saw a git branch or remote on a line at
 * that directory (sessions.cwd_git; a folder that is not a repository never has one). A
 * session that merely ran there is not evidence, nor its git_branch alone: a session that
 * started in a folder of repositories and moved into one records the folder as its cwd and
 * that repository's branch.
 */
function repoEvidence(source) {
    return (dir) => source.mapped(dir) || source.gitSession(dir);
}
/**
 * Display names for repositories, unique where two different ones share a name: each of
 * those is shown by its path (`pathLabel` of its root, when that is unique among them),
 * else as "name (1)", "name (2)" in key order. A name in `reserved` (another row's label)
 * counts as shared too.
 */
export function distinctNames(repos, pathLabel, reserved = new Set()) {
    const byName = new Map();
    for (const r of repos) {
        const name = repoName(r.key);
        let list = byName.get(name);
        if (!list)
            byName.set(name, (list = []));
        if (!list.some((x) => x.key === r.key))
            list.push(r);
    }
    const out = new Map();
    for (const [name, list] of byName) {
        if (list.length === 1 && !reserved.has(name)) {
            out.set(list[0].key, name);
            continue;
        }
        list.sort((x, y) => x.key.localeCompare(y.key));
        const paths = list.map((r) => (r.root ? pathLabel(r.root) : null));
        list.forEach((r, i) => {
            const path = paths[i];
            const unique = path !== null && path !== name && !reserved.has(path) && paths.filter((p) => p === path).length === 1;
            out.set(r.key, unique ? path : `${name} (${i + 1})`);
        });
    }
    return out;
}
/** A cwd as the resolver compares it: an absolute path loses its trailing slashes. */
function cleanCwd(cwd) {
    return cwd.startsWith("/") ? trimSlash(cwd) : cwd;
}
/** The repository key of an implicit map row: the first of the remotes that normalises. */
function implicitKey(remotes, aliases) {
    for (const remote of remotes) {
        const key = normaliseRemote(remote, aliases);
        if (key)
            return key;
    }
    return null;
}
/** Most recent first: end time, else start time (none last), then sid. */
const IMPLICIT_ORDER = "coalesce(end_time, start_time) DESC, sid DESC";
/**
 * The implicit map rows of a host read from the database (index sessions_cwd), optionally
 * leaving one session out. A stored cwd with trailing slashes counts as the same directory.
 */
function dbImplicitRemotes(db) {
    const rows = db.prepare(`SELECT git_remote FROM sessions
     WHERE cwd IN (@d, @d || '/') AND host = @h AND cwd_git = 1 AND git_remote IS NOT NULL AND sid != @except
     ORDER BY ${IMPLICIT_ORDER}`).pluck();
    return (host, dir, exceptSid = -1) => rows.iterate({ h: host, d: cleanCwd(dir), except: exceptSid });
}
/** The repository key the host's implicit map rows give `dir` (aliases from the environment), or null. */
export function implicitRepoKey(db) {
    const remotes = dbImplicitRemotes(db);
    return (host, dir, exceptSid) => implicitKey(remotes(host, dir, exceptSid), hostAliasesFromEnv());
}
/** A repository known by its remote. */
function remoteRepo(key, root) {
    return { key, name: lastSegment(key), root };
}
/** A repository known only by its path on `host`. */
function pathRepo(host, root) {
    return { key: pathKey(host, root), name: lastSegment(root), root };
}
/** The map row for `cwd` or its longest ancestor directory, segment-aware. */
function lookupMap(get, cwd) {
    let dir = trimSlash(cwd);
    for (;;) {
        const row = get(dir);
        if (row)
            return row;
        const slash = dir.lastIndexOf("/");
        if (slash < 0 || dir === "/")
            return undefined;
        dir = slash === 0 ? "/" : dir.slice(0, slash);
    }
}
/**
 * The one resolution path, for resolve-on-write and the full pass alike. `get`, `isRepoDir`
 * and `implicit` read the facts of `input.host` only. Precedence: the session's own remote
 * when it was seen at the cwd (cwdGit); the map row for the cwd or its longest ancestor; the
 * session's own remote seen elsewhere; the implicit map row for exactly the cwd (key only);
 * worktree folding; the cwd itself. The root is the map row's when one matches, else the
 * folded cwd; an implicit row never changes it. A map row that wins gives key and root both.
 */
function resolveWith(get, isRepoDir, implicit, input, aliases, containers) {
    const cwd = input.cwd ? cleanCwd(input.cwd) : null;
    const row = cwd ? lookupMap(get, cwd) : undefined;
    const root = row ? row.root : cwd ? foldWorktreePath(cwd, isRepoDir, containers) : null;
    const own = input.gitRemote ? normaliseRemote(input.gitRemote, aliases) : null;
    if (own && input.cwdGit)
        return remoteRepo(own, root);
    if (row) {
        const key = row.remote ? normaliseRemote(row.remote, aliases) : null;
        return key ? remoteRepo(key, row.root) : pathRepo(input.host, row.root);
    }
    if (own)
        return remoteRepo(own, root);
    if (!cwd)
        return null;
    const key = implicitKey(implicit(cwd), aliases);
    if (key)
        return remoteRepo(key, root);
    return pathRepo(input.host, root);
}
/** The repository of one session, with its statements prepared once, for callers that resolve many times. */
export function repoResolver(db) {
    const mapRow = db.prepare("SELECT root, remote FROM repo_map WHERE host = ? AND dir = ?");
    const mapped = db.prepare("SELECT 1 FROM repo_map WHERE host = @h AND (dir = @d OR root = @d) LIMIT 1");
    const git = db.prepare("SELECT 1 FROM sessions WHERE host = ? AND cwd = ? AND cwd_git = 1 LIMIT 1");
    const implicit = dbImplicitRemotes(db);
    // Aliases and container names are read per call: they come from the environment, which may change.
    return (input) => {
        const h = input.host;
        const isRepoDir = repoEvidence({
            mapped: (d) => mapped.get({ h, d }) !== undefined,
            gitSession: (d) => git.get(h, d) !== undefined,
        });
        return resolveWith((dir) => mapRow.get(h, dir), isRepoDir, (dir) => implicit(h, dir), input, hostAliasesFromEnv(), CONFIG.worktreeDirs);
    };
}
/**
 * Meta key set when a session gives the first git evidence (cwd_git) for its directory on its
 * host, or changes the implicit map row of its directory (a cwd_git session with a remote):
 * the next sweep then runs the full pass, since that directory may now fold worktree
 * sessions, or give a repository key to sessions, resolved before it.
 */
export const REPO_NEW_DIR_KEY = "repo_new_dir";
/** Bumped when the resolution rules change, so stored resolutions are recomputed once. */
const RESOLVER_REVISION = 1;
/** What meta `repo_resolved` must hold for the stored resolutions to be current: rules, aliases and container names. */
export function repoResolvedStamp() {
    const aliases = [...hostAliasesFromEnv()].sort().map(([a, b]) => `${a}=${b}`).join(",");
    const containers = [...CONFIG.worktreeDirs].sort().join(",");
    return `4:${createHash("sha1").update(`${RESOLVER_REVISION}\n${aliases}\n${containers}`).digest("hex").slice(0, 8)}`;
}
/** A value per host, then per directory. */
function perHost(outer, host) {
    let inner = outer.get(host);
    if (!inner)
        outer.set(host, (inner = new Map()));
    return inner;
}
/** Recompute sessions.repo and repo_root for every session; `changed` counts the sessions rewritten. */
export function resolveAllSessions(db) {
    const aliases = hostAliasesFromEnv();
    const containers = CONFIG.worktreeDirs;
    return db.transaction(() => {
        const map = new Map();
        const mapped = new Map();
        for (const r of db.prepare("SELECT host, dir, root, remote FROM repo_map").all()) {
            perHost(map, r.host).set(r.dir, { root: r.root, remote: r.remote });
            perHost(mapped, r.host).set(r.dir, true).set(r.root, true);
        }
        const sessions = db.prepare("SELECT sid, host, cwd, git_remote, cwd_git, repo, repo_root FROM sessions").all();
        const gitCwds = new Map();
        for (const s of sessions)
            if (s.cwd && s.cwd_git === 1)
                perHost(gitCwds, s.host).set(s.cwd, true);
        // Implicit map rows, read in their order (most recent first), as the database lookup reads them.
        const implicit = new Map();
        for (const r of db.prepare(`SELECT host, cwd, git_remote FROM sessions WHERE cwd IS NOT NULL AND cwd_git = 1 AND git_remote IS NOT NULL ORDER BY ${IMPLICIT_ORDER}`).all()) {
            const byDir = perHost(implicit, r.host);
            const dir = cleanCwd(r.cwd);
            let list = byDir.get(dir);
            if (!list)
                byDir.set(dir, (list = []));
            list.push(r.git_remote);
        }
        const update = db.prepare("UPDATE sessions SET repo = ?, repo_root = ? WHERE sid = ?");
        const cache = new Map();
        let changed = 0;
        for (const s of sessions) {
            const k = `${s.host}\0${s.cwd ?? ""}\0${s.git_remote ?? ""}\0${s.cwd_git === 1 ? 1 : 0}`;
            let repo = cache.get(k);
            if (repo === undefined) {
                const hostMap = map.get(s.host);
                const hostMapped = mapped.get(s.host);
                const hostGit = gitCwds.get(s.host);
                const hostImplicit = implicit.get(s.host);
                const isRepoDir = repoEvidence({ mapped: (d) => hostMapped?.has(d) ?? false, gitSession: (d) => hostGit?.has(d) ?? false });
                repo = resolveWith((dir) => hostMap?.get(dir), isRepoDir, (dir) => hostImplicit?.get(dir) ?? [], { host: s.host, cwd: s.cwd, gitRemote: s.git_remote, cwdGit: s.cwd_git === 1 }, aliases, containers);
                cache.set(k, repo);
            }
            const key = repo?.key ?? null;
            const root = repo?.root ?? null;
            if (key === s.repo && root === s.repo_root)
                continue;
            update.run(key, root, s.sid);
            changed++;
        }
        return { changed };
    }).immediate();
}
//# sourceMappingURL=resolve.js.map