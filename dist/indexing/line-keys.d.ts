/**
 * Claude transcript lines by uuid: the key each line is indexed under at most once, and the
 * order files are indexed in so that the session that started first keeps shared lines.
 *
 * Keyed lines: `type` "user" or "assistant", not `isMeta`, with a `message` object and a
 * non-empty string `uuid`. These are every line RowBuilder.addLine can turn into a message
 * row or merge into one (prompts, assistant blocks, tool results); other line types (system,
 * attachment, summary, titles) make no rows and are read as before.
 */
import type { TranscriptFile } from "../parsers/transcript-files.js";
/** 16 bytes: the uuid itself, or for a string that is not one, its sha256 cut to 16 bytes. */
export declare function uuidKey(uuid: string): Buffer;
/** The key of a Claude-shaped line, or null when the line is not keyed. */
export declare function lineKey(line: Record<string, unknown>): Buffer | null;
export interface FileStart {
    /** Timestamp (ms) of the first line of any type that has one; Infinity when none does. */
    first: number;
    /** Timestamp (ms) of the first keyed line; Infinity when there is none. */
    keyed: number;
    /** Key of the first keyed line. */
    key: Buffer | null;
}
/** How a Claude file starts, read from its first lines (at most 16 MB). */
export declare function fileStart(path: string): FileStart;
/** Which session holds a line now (a rebuild asks the database it replaces). */
export type LineHolder = (key: Buffer) => string | undefined;
/**
 * Files in the order a sweep indexes them, so that the session that existed first keeps the
 * lines a later one copied. Claude files come first, ordered by:
 *
 *   1. the timestamp of the file's first timestamped line of any type. A fork (Claude Code
 *      copying a session's history into a new session file) writes its leading lines (mode,
 *      attachments, queued prompts) when it is made, after the original started; the original's
 *      leading lines date from its own start.
 *   2. the timestamp of its first keyed line.
 *   3. when `holder` is given (a rebuild: the database being replaced), the file whose session
 *      holds its own first line comes first, so a tie keeps the owner the database had.
 *   4. session id, then path. On a fresh database an exact tie (a fork whose leading lines are
 *      copies too, sibling subagents that share their start) is decided here: arbitrarily.
 *
 * Two copies of one session file tie throughout and are read in path order. Other formats
 * follow in the order given (their own rules apply, e.g. Codex's first file wins).
 */
export declare function indexingOrder(files: TranscriptFile[], holder?: LineHolder): TranscriptFile[];
//# sourceMappingURL=line-keys.d.ts.map