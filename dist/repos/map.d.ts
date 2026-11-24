/**
 * The directory-to-repository map pushed by client machines. Each machine writes a small
 * JSON-lines file into the meta directory; one line records, for a work-tree directory,
 * its main repository root and origin URL. The files are untrusted input.
 */
import type { DB } from "../db/database.js";
/** Read every map file in mapDir, store each entry under `host`, and upsert entries with a newer `at`. `changed` is true when a row was written. */
export declare function loadRepoMaps(db: DB, mapDir: string, host: string): {
    files: number;
    entries: number;
    changed: boolean;
};
//# sourceMappingURL=map.d.ts.map