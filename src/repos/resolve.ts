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

import { createHash } from "crypto";
import { CONFIG } from "../config.js";
import type { DB } from "../db/database.js";
import { hostAliasesFromEnv, normaliseRemote } from "./url.js";

export interface Repo {
  /** Normalised remote (host/owner/name) when known, else pathKey(host, repository path). */
  key: string;
  /** The last path segment of the key (of the path, for a path key). */
  name: string;
  /** The main repository root: the map's, else the folded path; null when only a remote is known. */
  root: string | null;
}

interface MapRow {
  root: string;
  remote: string | null;
}

/** What the resolver is given for one session. `host` is the host stored on the session. */
export interface ResolveInput {
  host: string;
  cwd: string | null;
  gitRemote: string | null;
  /**
   * sessions.cwd_git: true when git evidence (a real branch, not HEAD, or a remote) was seen on a
   * line at the session's cwd. A remote without it describes another directory (a Codex header cwd the
   * session left), so a map row for the cwd wins over it.
   */
  cwdGit: boolean;
}

/** True when there is evidence that a directory is a repository (on the host being resolved). */
export type RepoDirTest = (dir: string) => boolean;

/**
 * Implicit map rows: for a directory, the raw git remotes of the host's sessions whose cwd is
 * exactly that directory and that saw git evidence there (cwd_git = 1), most recent first (by
 * end time, else start time, then sid). Codex computed such a remote with git at that very
 * directory, so it names the directory's repository. Only the exact directory: cwd_git shows
 * "inside a work tree", not "is its root", and an ancestor match could swallow a nested,
 * separate repository.
 */
type ImplicitRemotes = (dir: string) => Iterable<string>;

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

function escapeRegExp(text: string): string {
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
export function foldWorktreePath(cwd: string, isRepoDir?: RepoDirTest, containers: string[] = CONFIG.worktreeDirs): string {
  const path = trimSlash(cwd);
  const claude = /^(.+?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/.exec(path);
  if (claude) return claude[1];
  if (containers.length === 0 || !isRepoDir) return path;
  const names = containers.map(escapeRegExp).join("|");
  const worktree = new RegExp(`^(.+?)\\/(?:${names})\\/[^/]+(?:\\/.*)?$`).exec(path);
  if (worktree && isRepoDir(worktree[1])) return worktree[1];
  return path;
}

/** The key of a repository known only by its path: `<host>:<path>`, or the plain path when host is unknown (''). */
export function pathKey(host: string, path: string): string {
  return host === "" ? path : `${host}:${path}`;
}

/** True when `key` is the path key of a repository rooted at `root` on `host`, that is, one known by no remote. */
export function isPathKey(host: string, key: string, root: string): boolean {
  return key === pathKey(host, root);
}

/** The last path segment: a repository key's name, a directory's base name. */
export function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The display name of a repository key: the last segment of the remote (`host/owner/name`) or
 * of the path in a path key. A path key's `<host>:` prefix is never part of the name, even when
 * the path has no segment of its own (the filesystem root).
 */
export function repoName(key: string): string {
  return lastSegment(key.replace(/^[^/]*:(?=\/)/, ""));
}

/** Where one host's repository evidence is read from: the database, or sets loaded once for a full pass. */
interface EvidenceSource {
  /** `dir` is a repo_map dir or root of the host. */
  mapped(dir: string): boolean;
  /** Some session of the host with cwd = `dir` saw a real git branch (not HEAD) or a remote on a line at that cwd (sessions.cwd_git). */
  gitSession(dir: string): boolean;
}

/**
 * The one test of strong evidence that a directory is a git work tree: the host's pushed map
 * names it, or a session of the host that ran in it saw a git branch or remote on a line at
 * that directory (sessions.cwd_git). A branch named HEAD is not evidence: it is what a folder
 * that is no repository reports, and a detached checkout too. A
 * session that merely ran there is not evidence, nor its git_branch alone: a session that
 * started in a folder of repositories and moved into one records the folder as its cwd and
 * that repository's branch.
 */
function repoEvidence(source: EvidenceSource): RepoDirTest {
  return (dir) => source.mapped(dir) || source.gitSession(dir);
}

/** A repository key taken apart: a remote key `host/owner/name`, or a path key (see pathKey). */
type KeyParts = { remote: true; ownerName: string } | { remote: false; host: string };

function keyParts(key: string): KeyParts {
  // A bare Windows drive path first: `C:/w/app` is not host `C` with a POSIX path.
  if (/^[A-Za-z]:[\\/]/.test(key)) return { remote: false, host: "" };
  const path = /^([^/:]*):(?=\/)/.exec(key);
  if (path) return { remote: false, host: path[1] };
  if (key.startsWith("/")) return { remote: false, host: "" };
  // A host-prefixed Windows path (drive path, or anything with a backslash; a remote never has one).
  const windows = /^([^/\\:]+):(?=[A-Za-z]:[\\/]|.*\\)/.exec(key);
  if (windows) return { remote: false, host: windows[1] };
  if (key.includes("\\")) return { remote: false, host: "" };
  return { remote: true, ownerName: key.split("/").slice(-2).join("/") };
}

/** The host of a path key (`<host>:<path>`); null for a remote key or a path key with no host. */
export function pathKeyHost(key: string): string | null {
  const k = keyParts(key);
  return !k.remote && k.host !== "" ? k.host : null;
}

/**
 * Display names for repositories, unique where two different ones share a name: each of
 * those is shown by its path (`pathLabel` of its root, when that is unique among them).
 * Failing that, the first of these that no other repository of the name wants at the same
 * step: `owner/name` for a remote key, then the full remote key, or `name @host` for a path
 * key with a host; else "name (1)", "name (2)" in key order. A name in `reserved` (another
 * row's label) counts as shared too, and is never used as a label.
 */
export function distinctNames(
  repos: Iterable<{ key: string; root: string | null }>,
  pathLabel: (root: string) => string | null,
  reserved: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const byName = new Map<string, Array<{ key: string; root: string | null }>>();
  for (const r of repos) {
    const name = repoName(r.key);
    let list = byName.get(name);
    if (!list) byName.set(name, (list = []));
    if (!list.some((x) => x.key === r.key)) list.push(r);
  }
  const out = new Map<string, string>();
  for (const [name, list] of byName) {
    if (list.length === 1 && !reserved.has(name)) {
      out.set(list[0].key, name);
      continue;
    }
    list.sort((x, y) => x.key.localeCompare(y.key));
    const taken = new Set<string>(reserved);
    taken.add(name);
    const steps: Array<(r: { key: string; root: string | null }) => string | null> = [
      (r) => (r.root ? pathLabel(r.root) : null),
      (r) => { const k = keyParts(r.key); return k.remote ? k.ownerName : null; },
      (r) => (keyParts(r.key).remote ? r.key : null),
      (r) => { const k = keyParts(r.key); return !k.remote && k.host !== "" ? `${name} @${k.host}` : null; },
    ];
    let pending = list;
    for (const step of steps) {
      const wanted = pending.map(step);
      pending = pending.filter((r, i) => {
        const label = wanted[i];
        if (label === null || taken.has(label) || wanted.filter((w) => w === label).length !== 1) return true;
        out.set(r.key, label);
        return false;
      });
      for (const r of list) {
        const label = out.get(r.key);
        if (label !== undefined) taken.add(label);
      }
    }
    list.forEach((r, i) => {
      if (!out.has(r.key)) out.set(r.key, `${name} (${i + 1})`);
    });
  }
  return out;
}

/** A cwd as the resolver compares it: an absolute path loses its trailing slashes. */
function cleanCwd(cwd: string): string {
  return cwd.startsWith("/") ? trimSlash(cwd) : cwd;
}

/** The repository key of an implicit map row: the first of the remotes that normalises. */
function implicitKey(remotes: Iterable<string>, aliases: Map<string, string>): string | null {
  for (const remote of remotes) {
    const key = normaliseRemote(remote, aliases);
    if (key) return key;
  }
  return null;
}

/** Most recent first: end time, else start time (none last), then sid. */
const IMPLICIT_ORDER = "coalesce(end_time, start_time) DESC, sid DESC";

/**
 * The implicit map rows of a host read from the database (index sessions_cwd), optionally
 * leaving one session out. A stored cwd with trailing slashes counts as the same directory.
 */
function dbImplicitRemotes(db: DB): (host: string, dir: string, exceptSid?: number) => Iterable<string> {
  const rows = db.prepare(
    `SELECT git_remote FROM sessions
     WHERE cwd IN (@d, @d || '/') AND host = @h AND cwd_git = 1 AND git_remote IS NOT NULL AND sid != @except
     ORDER BY ${IMPLICIT_ORDER}`
  ).pluck();
  return (host, dir, exceptSid = -1) => rows.iterate({ h: host, d: cleanCwd(dir), except: exceptSid }) as Iterable<string>;
}

/** The repository key the host's implicit map rows give `dir` (aliases from the environment), or null. */
export function implicitRepoKey(db: DB): (host: string, dir: string, exceptSid?: number) => string | null {
  const remotes = dbImplicitRemotes(db);
  return (host, dir, exceptSid) => implicitKey(remotes(host, dir, exceptSid), hostAliasesFromEnv());
}

/** A repository known by its remote. */
function remoteRepo(key: string, root: string | null): Repo {
  return { key, name: lastSegment(key), root };
}

/** A repository known only by its path on `host`. */
function pathRepo(host: string, root: string): Repo {
  return { key: pathKey(host, root), name: lastSegment(root), root };
}

/** The map row for `cwd` or its longest ancestor directory, segment-aware. */
function lookupMap(get: (dir: string) => MapRow | undefined, cwd: string): MapRow | undefined {
  let dir = trimSlash(cwd);
  for (;;) {
    const row = get(dir);
    if (row) return row;
    const slash = dir.lastIndexOf("/");
    if (slash < 0 || dir === "/") return undefined;
    dir = slash === 0 ? "/" : dir.slice(0, slash);
  }
}

/**
 * The one resolution path, for resolve-on-write and the full pass alike. `get`, `isRepoDir`
 * and `implicit` read the facts of `input.host` only. Precedence: the session's own remote
 * when it was seen at the cwd (cwdGit); the map row for the cwd or its longest ancestor; the
 * implicit map row for exactly the cwd (key only); the session's own remote seen elsewhere
 * (key only); worktree folding; the cwd itself. A remote another session saw at this very
 * directory says more about it than one this session saw only at another directory. The root
 * is the map row's when one matches, else the folded cwd; neither an implicit row nor a remote
 * seen elsewhere changes it. A map row that wins gives key and root both.
 */
function resolveWith(
  get: (dir: string) => MapRow | undefined,
  isRepoDir: RepoDirTest,
  implicit: ImplicitRemotes,
  input: ResolveInput,
  aliases: Map<string, string>,
  containers: string[],
): Repo | null {
  const cwd = input.cwd ? cleanCwd(input.cwd) : null;
  const row = cwd ? lookupMap(get, cwd) : undefined;
  const root = row ? row.root : cwd ? foldWorktreePath(cwd, isRepoDir, containers) : null;

  const own = input.gitRemote ? normaliseRemote(input.gitRemote, aliases) : null;
  if (own && input.cwdGit) return remoteRepo(own, root);
  if (row) {
    const key = row.remote ? normaliseRemote(row.remote, aliases) : null;
    return key ? remoteRepo(key, row.root) : pathRepo(input.host, row.root);
  }
  const key = cwd ? implicitKey(implicit(cwd), aliases) : null;
  if (key) return remoteRepo(key, root);
  if (own) return remoteRepo(own, root);
  return cwd ? pathRepo(input.host, root as string) : null;
}

/** The test of strong repository evidence (see repoEvidence) for a directory of a host, read from the database. */
export function dbRepoEvidence(db: DB): (host: string, dir: string) => boolean {
  const mapped = db.prepare("SELECT 1 FROM repo_map WHERE host = @h AND (dir = @d OR root = @d) LIMIT 1");
  const git = db.prepare("SELECT 1 FROM sessions WHERE host = ? AND cwd = ? AND cwd_git = 1 LIMIT 1");
  return (h, dir) => repoEvidence({
    mapped: (d) => mapped.get({ h, d }) !== undefined,
    gitSession: (d) => git.get(h, d) !== undefined,
  })(dir);
}

/** The repository of one session, with its statements prepared once, for callers that resolve many times. */
export function repoResolver(db: DB): (input: ResolveInput) => Repo | null {
  const mapRow = db.prepare("SELECT root, remote FROM repo_map WHERE host = ? AND dir = ?");
  const evidence = dbRepoEvidence(db);
  const implicit = dbImplicitRemotes(db);
  // Aliases and container names are read per call: they come from the environment, which may change.
  return (input) => {
    const h = input.host;
    const isRepoDir: RepoDirTest = (d) => evidence(h, d);
    return resolveWith((dir) => mapRow.get(h, dir) as MapRow | undefined, isRepoDir, (dir) => implicit(h, dir), input,
      hostAliasesFromEnv(), CONFIG.worktreeDirs);
  };
}

/**
 * Meta key set when a session gives the first git evidence (cwd_git) for its directory on its
 * host, or changes the implicit map row of its directory (a cwd_git session with a remote):
 * the next sweep then runs the full pass, since that directory may now fold worktree
 * sessions, or give a repository key to sessions resolved before it (those known only by
 * path, and those whose own remote was seen at another directory).
 */
export const REPO_NEW_DIR_KEY = "repo_new_dir";

/** Bumped when the resolution rules change, so stored resolutions are recomputed once. */
const RESOLVER_REVISION = 2;

/** What meta `repo_resolved` must hold for the stored resolutions to be current: rules, aliases and container names. */
export function repoResolvedStamp(): string {
  const aliases = [...hostAliasesFromEnv()].sort().map(([a, b]) => `${a}=${b}`).join(",");
  const containers = [...CONFIG.worktreeDirs].sort().join(",");
  return `4:${createHash("sha1").update(`${RESOLVER_REVISION}\n${aliases}\n${containers}`).digest("hex").slice(0, 8)}`;
}

/** A value per host, then per directory. */
function perHost<T>(outer: Map<string, Map<string, T>>, host: string): Map<string, T> {
  let inner = outer.get(host);
  if (!inner) outer.set(host, (inner = new Map()));
  return inner;
}

/** Recompute sessions.repo and repo_root for every session; `changed` counts the sessions rewritten. */
export function resolveAllSessions(db: DB): { changed: number } {
  const aliases = hostAliasesFromEnv();
  const containers = CONFIG.worktreeDirs;
  return db.transaction(() => {
    const map = new Map<string, Map<string, MapRow>>();
    const mapped = new Map<string, Map<string, true>>();
    for (const r of db.prepare("SELECT host, dir, root, remote FROM repo_map").all() as Array<MapRow & { host: string; dir: string }>) {
      perHost(map, r.host).set(r.dir, { root: r.root, remote: r.remote });
      perHost(mapped, r.host).set(r.dir, true).set(r.root, true);
    }
    const sessions = db.prepare("SELECT sid, host, cwd, git_remote, cwd_git, repo, repo_root FROM sessions").all() as Array<{
      sid: number; host: string; cwd: string | null; git_remote: string | null; cwd_git: number;
      repo: string | null; repo_root: string | null;
    }>;
    const gitCwds = new Map<string, Map<string, true>>();
    for (const s of sessions) if (s.cwd && s.cwd_git === 1) perHost(gitCwds, s.host).set(s.cwd, true);
    // Implicit map rows, read in their order (most recent first), as the database lookup reads them.
    const implicit = new Map<string, Map<string, string[]>>();
    for (const r of db.prepare(
      `SELECT host, cwd, git_remote FROM sessions WHERE cwd IS NOT NULL AND cwd_git = 1 AND git_remote IS NOT NULL ORDER BY ${IMPLICIT_ORDER}`
    ).all() as Array<{ host: string; cwd: string; git_remote: string }>) {
      const byDir = perHost(implicit, r.host);
      const dir = cleanCwd(r.cwd);
      let list = byDir.get(dir);
      if (!list) byDir.set(dir, (list = []));
      list.push(r.git_remote);
    }
    const update = db.prepare("UPDATE sessions SET repo = ?, repo_root = ? WHERE sid = ?");
    const cache = new Map<string, Repo | null>();
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
        repo = resolveWith(
          (dir) => hostMap?.get(dir),
          isRepoDir,
          (dir) => hostImplicit?.get(dir) ?? [],
          { host: s.host, cwd: s.cwd, gitRemote: s.git_remote, cwdGit: s.cwd_git === 1 },
          aliases,
          containers,
        );
        cache.set(k, repo);
      }
      const key = repo?.key ?? null;
      const root = repo?.root ?? null;
      if (key === s.repo && root === s.repo_root) continue;
      update.run(key, root, s.sid);
      changed++;
    }
    return { changed };
  }).immediate();
}
