/**
 * The directory-to-repository map pushed by client machines. Each machine writes a small
 * JSON-lines file into the meta directory; one line records, for a work-tree directory,
 * its main repository root and origin URL. The files are untrusted input.
 */
import type { DB } from "../db/database.js";
/**
 * Read the map files in mapDir, store each entry under `host`, and upsert entries with a newer
 * `at`. `changed` is true when a row was written. By default every `*.jsonl` file below mapDir is
 * read (a directory that holds one host's files); `options.file` reads that one file only, as
 * the local sweep does with `<host>.jsonl`, so another host's file in a shared directory never
 * applies to this host.
 */
export declare function loadRepoMaps(db: DB, mapDir: string, host: string, options?: {
    file?: string;
}): {
    files: number;
    entries: number;
    changed: boolean;
};
//# sourceMappingURL=map.d.ts.map