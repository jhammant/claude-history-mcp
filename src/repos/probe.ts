/**
 * Asks local git which repository a directory belongs to and appends the answer to this
 * machine's repository map file. Git is only ever run locally (no network, no prompts, a short
 * timeout); every failure means "no answer", never an exception.
 */

import { execFileSync } from "child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { CONFIG } from "../config.js";
import { canonicalRemote, parseLine } from "./map.js";
import { stripRemoteCredentials } from "./url.js";

export interface MapEntry {
  dir: string;
  root: string;
  remote: string | null;
}

/** Run git and return trimmed stdout, or null on any failure (missing git, timeout, non-zero exit). */
function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }).replace(/\r?\n$/, "");
  } catch {
    return null;
  }
}

/** The main repository root for a work tree whose common git dir is `common`. */
function mainRoot(common: string): string {
  if (git([`--git-dir=${common}`, "rev-parse", "--is-bare-repository"]) === "true") return common;
  if (basename(common) === ".git") return dirname(common);
  // Separate git dir or submodule: core.worktree when set, else the common dir is the only stable key.
  const configured = git([`--git-dir=${common}`, "config", "--get", "core.worktree"]);
  if (configured) {
    const absolute = isAbsolute(configured) ? configured : join(common, configured);
    const real = tryRealpath(absolute);
    if (real) return real;
  }
  return common;
}

function tryRealpath(path: string): string | null {
  try {
    // Resolve symlinks and `..` the way `cd && pwd -P` does.
    return resolve(realpathSync(path));
  } catch {
    return null;
  }
}

/**
 * The map entries for `dir`: the physical work-tree top and, when `dir` was reached through a
 * symlink, the logical top too (sessions record the logical cwd). Empty when `dir` is missing,
 * not in a work tree, or git is unavailable.
 */
export function probeRepo(dir: string): MapEntry[] {
  // No stat first: on a dead network mount it could block with no timeout. Git fails fast for a
  // missing directory or a file. Each git call has a timeout that signals the child; a mount that
  // is hard-hung can still hold the process longer.
  // An empty path is refused here because `git -C ""` is a no-op and would probe the process's own directory.
  if (!dir) return [];
  const top = git(["-C", dir, "rev-parse", "--show-toplevel"]);
  if (!top) return [];
  const common = git(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return [];
  const root = mainRoot(common);
  if (!root) return [];
  const rawRemote = git(["-C", dir, "remote", "get-url", "origin"]);
  const remote = rawRemote ? stripRemoteCredentials(rawRemote) || null : null;
  const entries: MapEntry[] = [{ dir: top, root, remote }];

  const logical = logicalTop(dir, top);
  if (logical) entries.push({ dir: logical, root, remote });
  return entries;
}

/** `dir` with its show-prefix removed, when that is a different spelling of the same work tree. */
function logicalTop(dir: string, top: string): string | null {
  if (!dir.startsWith("/")) return null;
  let clean = dir;
  while (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  if (/\/\/|\/\.\/|\/\.\.\/|\/\.$|\/\.\.$/.test(clean)) return null;
  const prefixRaw = git(["-C", clean, "rev-parse", "--show-prefix"]);
  if (prefixRaw === null) return null;
  const prefix = prefixRaw.replace(/\/$/, "");
  let logical: string;
  if (!prefix) logical = clean;
  else if (clean.endsWith(`/${prefix}`)) logical = clean.slice(0, clean.length - prefix.length - 1);
  else return null;
  if (!logical || logical === top) return null;
  // The text check is not proof: the candidate must really be this work tree.
  return git(["-C", logical, "rev-parse", "--show-toplevel"]) === top ? logical : null;
}

/** What a map line says about its directory: root and remote, as compared before appending. */
function value(root: string, remote: string | null): string {
  // The remote as the loader will store it, so a line the loader cannot recognise is not appended again each probe.
  return JSON.stringify([root, remote === null ? null : canonicalRemote(remote)]);
}

/**
 * The newest line per directory already in the file, as the loader picks it: the lines the
 * loader accepts (`parseLine`), the highest `at`, and on a tie the later line.
 */
function newestLines(file: string): Map<string, { value: string; at: number }> {
  const newest = new Map<string, { value: string; at: number }>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return newest;
  }
  const nowSeconds = Date.now() / 1000;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseLine(line, nowSeconds);
    if (!entry) continue;
    const prior = newest.get(entry.dir);
    if (!prior || entry.at >= prior.at) newest.set(entry.dir, { value: value(entry.root, entry.remote), at: entry.at });
  }
  return newest;
}

/**
 * Probe each directory and append every entry that differs from the newest line for its
 * directory in `<mapDir>/<host>.jsonl` (or has none). Returns the number of lines added. Never
 * throws. Only a map directory created here gets mode 0700; an existing one keeps its mode.
 */
export function recordRepos(dirs: Iterable<string>, options: { mapDir?: string; host?: string; now?: number } = {}): number {
  try {
    const mapDir = options.mapDir ?? CONFIG.repoMapDir;
    const file = join(mapDir, `${options.host ?? CONFIG.host}.jsonl`);
    const at = Math.floor(options.now ?? Date.now() / 1000);
    let newest: Map<string, { value: string; at: number }> | null = null;
    let added = 0;
    for (const dir of dirs) {
      for (const entry of probeRepo(dir)) {
        if (!newest) {
          if (mkdirSync(mapDir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(mapDir, 0o700);
          newest = newestLines(file);
        }
        const v = value(entry.root, entry.remote);
        const prior = newest.get(entry.dir);
        if (prior && prior.value === v) continue;
        appendFileSync(file, JSON.stringify({ dir: entry.dir, root: entry.root, remote: entry.remote, at }) + "\n", { mode: 0o600 });
        chmodSync(file, 0o600);
        newest.set(entry.dir, { value: v, at });
        added++;
      }
    }
    return added;
  } catch {
    return 0;
  }
}
