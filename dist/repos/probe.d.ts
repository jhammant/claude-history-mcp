/**
 * Asks local git which repository a directory belongs to and appends the answer to this
 * machine's repository map file. Git is only ever run locally (no network, no prompts, a short
 * timeout); every failure means "no answer", never an exception.
 */
export interface MapEntry {
    dir: string;
    root: string;
    remote: string | null;
}
/**
 * The map entries for `dir`: the physical work-tree top and, when `dir` was reached through a
 * symlink, the logical top too (sessions record the logical cwd). Empty when `dir` is missing,
 * not in a work tree, or git is unavailable.
 */
export declare function probeRepo(dir: string): MapEntry[];
/**
 * Probe each directory and append every entry not already in `<mapDir>/<host>.jsonl`.
 * Returns the number of lines added. Never throws.
 */
export declare function recordRepos(dirs: Iterable<string>, options?: {
    mapDir?: string;
    host?: string;
    now?: number;
}): number;
//# sourceMappingURL=probe.d.ts.map