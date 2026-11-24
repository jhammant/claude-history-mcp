/**
 * Asks local git which repository a directory belongs to and appends the answer to this
 * machine's repository map file. Git is only ever run locally (no network, no prompts, a short
 * timeout); every failure means "no answer", never an exception.
 */
import { execFileSync } from "child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { CONFIG } from "../config.js";
import { stripRemoteCredentials } from "./url.js";
/** Run git and return trimmed stdout, or null on any failure (missing git, timeout, non-zero exit). */
function git(args) {
    try {
        return execFileSync("git", args, {
            timeout: 5000,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        }).replace(/\r?\n$/, "");
    }
    catch {
        return null;
    }
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** The main repository root for a work tree whose common git dir is `common`. */
function mainRoot(common) {
    if (git([`--git-dir=${common}`, "rev-parse", "--is-bare-repository"]) === "true")
        return common;
    if (basename(common) === ".git")
        return dirname(common);
    // Separate git dir or submodule: core.worktree when set, else the common dir is the only stable key.
    const configured = git([`--git-dir=${common}`, "config", "--get", "core.worktree"]);
    if (configured) {
        const absolute = isAbsolute(configured) ? configured : join(common, configured);
        const real = tryRealpath(absolute);
        if (real)
            return real;
    }
    return common;
}
function tryRealpath(path) {
    try {
        // Resolve symlinks and `..` the way `cd && pwd -P` does.
        return resolve(realpathSync(path));
    }
    catch {
        return null;
    }
}
/**
 * The map entries for `dir`: the physical work-tree top and, when `dir` was reached through a
 * symlink, the logical top too (sessions record the logical cwd). Empty when `dir` is missing,
 * not in a work tree, or git is unavailable.
 */
export function probeRepo(dir) {
    if (!isDirectory(dir))
        return [];
    const top = git(["-C", dir, "rev-parse", "--show-toplevel"]);
    if (!top)
        return [];
    const common = git(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common)
        return [];
    const root = mainRoot(common);
    if (!root)
        return [];
    const rawRemote = git(["-C", dir, "remote", "get-url", "origin"]);
    const remote = rawRemote ? stripRemoteCredentials(rawRemote) || null : null;
    const entries = [{ dir: top, root, remote }];
    const logical = logicalTop(dir, top);
    if (logical)
        entries.push({ dir: logical, root, remote });
    return entries;
}
/** `dir` with its show-prefix removed, when that is a different spelling of the same work tree. */
function logicalTop(dir, top) {
    if (!dir.startsWith("/"))
        return null;
    let clean = dir;
    while (clean.length > 1 && clean.endsWith("/"))
        clean = clean.slice(0, -1);
    if (/\/\/|\/\.\/|\/\.\.\/|\/\.$|\/\.\.$/.test(clean))
        return null;
    const prefixRaw = git(["-C", clean, "rev-parse", "--show-prefix"]);
    if (prefixRaw === null)
        return null;
    const prefix = prefixRaw.replace(/\/$/, "");
    let logical;
    if (!prefix)
        logical = clean;
    else if (clean.endsWith(`/${prefix}`))
        logical = clean.slice(0, clean.length - prefix.length - 1);
    else
        return null;
    if (!logical || logical === top)
        return null;
    // The text check is not proof: the candidate must really be this work tree.
    return git(["-C", logical, "rev-parse", "--show-toplevel"]) === top ? logical : null;
}
function key(dir, root, remote) {
    return JSON.stringify([dir, root, remote]);
}
/** Keys of the entries already in the file; unparseable lines are ignored. */
function existingKeys(file) {
    const keys = new Set();
    let text;
    try {
        text = readFileSync(file, "utf8");
    }
    catch {
        return keys;
    }
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const o = JSON.parse(line);
            if (o && typeof o === "object" && typeof o.dir === "string" && typeof o.root === "string") {
                keys.add(key(o.dir, o.root, typeof o.remote === "string" && o.remote ? o.remote : null));
            }
        }
        catch {
            // corrupt line
        }
    }
    return keys;
}
/**
 * Probe each directory and append every entry not already in `<mapDir>/<host>.jsonl`.
 * Returns the number of lines added. Never throws.
 */
export function recordRepos(dirs, options = {}) {
    try {
        const mapDir = options.mapDir ?? CONFIG.repoMapDir;
        const file = join(mapDir, `${options.host ?? CONFIG.host}.jsonl`);
        const at = Math.floor(options.now ?? Date.now() / 1000);
        let seen = null;
        let added = 0;
        for (const dir of dirs) {
            for (const entry of probeRepo(dir)) {
                if (!seen) {
                    mkdirSync(mapDir, { recursive: true, mode: 0o700 });
                    chmodSync(mapDir, 0o700);
                    seen = existingKeys(file);
                }
                const k = key(entry.dir, entry.root, entry.remote);
                if (seen.has(k))
                    continue;
                appendFileSync(file, JSON.stringify({ dir: entry.dir, root: entry.root, remote: entry.remote, at }) + "\n", { mode: 0o600 });
                chmodSync(file, 0o600);
                seen.add(k);
                added++;
            }
        }
        return added;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=probe.js.map