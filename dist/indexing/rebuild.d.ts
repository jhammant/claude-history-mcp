/**
 * Build a fresh database from the transcripts beside the live one, carry over every
 * session the transcripts no longer have (the archive), then swap it in.
 *
 * The swap uses SQLite's online backup into the live file rather than a rename: servers
 * keep the live file open, and renaming a WAL database under open connections can pair
 * the new file with the old WAL. The backup replaces every page in one write
 * transaction, so a reader sees either the old database or the new one.
 */
import { type SweepStats } from "./sweep.js";
export interface RebuildStats {
    sweep: SweepStats;
    /** Sessions copied from the old database because no transcript has them any more. */
    carriedSessions: number;
    carriedMessages: number;
    /**
     * Lines of carried sessions (by uuid) that a re-read session holds too: a fork whose original
     * transcript is gone. The carried rows keep them, so these lines are stored twice.
     */
    carriedSharedLines: number;
}
export declare function rebuild(livePath: string, progress?: (line: string) => void): Promise<RebuildStats>;
//# sourceMappingURL=rebuild.d.ts.map