/**
 * Page through a session's stored messages, including sessions whose transcript file
 * Claude Code has since deleted.
 */
import type { DB } from "../db/database.js";
export interface ReadSessionArgs {
    session_id: string;
    /** Centre the page on this message number. */
    around?: number;
    /** First message number of the page. */
    from?: number;
    /** Last message number of the page (inclusive). */
    to?: number;
    /** Most messages to return (default 20, max 100). */
    limit?: number;
    /** Most characters per message (default 2000). */
    max_chars?: number;
}
export interface SessionRow {
    sid: number;
    id: string;
    project: string;
    cwd: string | null;
    git_branch: string | null;
    source: string;
    is_subagent: number;
    parent_session: string | null;
    title: string | null;
    first_prompt: string | null;
    start_time: number | null;
    end_time: number | null;
    message_count: number;
    legacy: number;
}
/** Find a session by full id, or by an unambiguous prefix of at least 6 characters. */
export declare function resolveSession(db: DB, idOrPrefix: string): SessionRow | {
    ambiguous: string[];
} | null;
export declare function readSession(db: DB, args: ReadSessionArgs): string;
//# sourceMappingURL=read-session.d.ts.map