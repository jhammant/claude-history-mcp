/**
 * Which repository a session belongs to. Four facts, in order of trust: the session's own
 * git remote when it was seen at the session's cwd (Codex records one), the pushed directory
 * map, the remote of another session that ran at exactly the same directory with git evidence
 * there (an implicit map row), and path patterns for well-known worktree layouts; the working
 * directory itself is the last resort. A session remote seen at another directory ranks below
 * the map and the implicit row: it is used only when neither names the cwd.
 *
 * Every fact but a remote is scoped by host: a path names a directory on one machine, so the
 * same path on two machines is never assumed to be the same repository. A repository with a
 * remote is keyed `host/owner/name` (the remote's host) and is the same on every machine; one
 * without is keyed `<host>:<path>` (see pathKey).
 */
import type { DB } from "../db/database.js";
export interface Repo {
    /** Normalised remote (host/owner/name) when known, else pathKey(host, repository path). */
    key: string;
    /** The last path segment of the key (of the path, for a path key). */
    name: string;
    /** The main repository root: the map's, else the folded path; null when only a remote is known. */
    root: string | null;
}
/** What the resolver is given for one session. `host` is the host stored on the session. */
export interface ResolveInput {
    host: string;
    cwd: string | null;
    gitRemote: string | null;
    /**
     * sessions.cwd_git: true when git evidence (a branch or remote) was seen on a line at the
     * session's cwd. A remote without it describes another directory (a Codex header cwd the
     * session left), so a map row for the cwd wins over it.
     */
    cwdGit: boolean;
}
/** True when there is evidence that a directory is a repository (on the host being resolved). */
export type RepoDirTest = (dir: string) => boolean;
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
export declare function foldWorktreePath(cwd: string, isRepoDir?: RepoDirTest, containers?: string[]): string;
/** The key of a repository known only by its path: `<host>:<path>`, or the plain path when host is unknown (''). */
export declare function pathKey(host: string, path: string): string;
/** True when `key` is the path key of a repository rooted at `root` on `host`, that is, one known by no remote. */
export declare function isPathKey(host: string, key: string, root: string): boolean;
/** The last path segment: a repository key's name, a directory's base name. */
export declare function lastSegment(path: string): string;
/**
 * The display name of a repository key: the last segment of the remote (`host/owner/name`) or
 * of the path in a path key. A path key's `<host>:` prefix is never part of the name, even when
 * the path has no segment of its own (the filesystem root).
 */
export declare function repoName(key: string): string;
/**
 * Display names for repositories, unique where two different ones share a name: each of
 * those is shown by its path (`pathLabel` of its root, when that is unique among them).
 * Failing that, the first of these that no other repository of the name wants at the same
 * step: `owner/name` for a remote key, then the full remote key, or `name @host` for a path
 * key with a host; else "name (1)", "name (2)" in key order. A name in `reserved` (another
 * row's label) counts as shared too, and is never used as a label.
 */
export declare function distinctNames(repos: Iterable<{
    key: string;
    root: string | null;
}>, pathLabel: (root: string) => string | null, reserved?: ReadonlySet<string>): Map<string, string>;
/** The repository key the host's implicit map rows give `dir` (aliases from the environment), or null. */
export declare function implicitRepoKey(db: DB): (host: string, dir: string, exceptSid?: number) => string | null;
/** The repository of one session, with its statements prepared once, for callers that resolve many times. */
export declare function repoResolver(db: DB): (input: ResolveInput) => Repo | null;
/**
 * Meta key set when a session gives the first git evidence (cwd_git) for its directory on its
 * host, or changes the implicit map row of its directory (a cwd_git session with a remote):
 * the next sweep then runs the full pass, since that directory may now fold worktree
 * sessions, or give a repository key to sessions resolved before it (those known only by
 * path, and those whose own remote was seen at another directory).
 */
export declare const REPO_NEW_DIR_KEY = "repo_new_dir";
/** What meta `repo_resolved` must hold for the stored resolutions to be current: rules, aliases and container names. */
export declare function repoResolvedStamp(): string;
/** Recompute sessions.repo and repo_root for every session; `changed` counts the sessions rewritten. */
export declare function resolveAllSessions(db: DB): {
    changed: number;
};
//# sourceMappingURL=resolve.d.ts.map