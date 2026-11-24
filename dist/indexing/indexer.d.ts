/**
 * Incremental, byte-offset indexing of one transcript file.
 *
 * Transcripts are append-only while a session runs, so a file that has only grown is
 * read from the stored offset, up to its last complete line. A file that shrank or was
 * replaced is indexed again from zero. Each batch of lines is written in one short
 * IMMEDIATE transaction that first re-checks the stored offset: if another process
 * indexed those bytes in the meantime, the batch is dropped, so racing indexers never
 * insert the same lines twice.
 *
 * One stored row per message. An assistant turn that Claude Code writes as several
 * lines (text, then each tool call) becomes one row, and the tool results that follow
 * it are added to that row, so a hit shows what was run next to what came back.
 *
 * Calls to this server's own tools keep their name, but neither their input nor their
 * result is indexed. Their results can arrive in a later append than the call, so the
 * calls still waiting for a result are kept with the file.
 *
 * A Claude line is indexed at most once across the database, keyed by its uuid (line-keys.ts):
 * Claude Code copies a session's history into a forked session's file, and the same session
 * file can be found under two spellings of one project path. The copies are skipped, so a
 * search finds the text once, in the session that had it first.
 */
import type { DB } from "../db/database.js";
import type { TranscriptFile } from "../parsers/transcript-files.js";
export type Role = "user" | "assistant" | "tool";
export interface IndexFileOptions {
    /** Stop after the batch in progress once Date.now() passes this. */
    deadline?: number;
    batchBytes?: number;
    /** Machine name recorded on a session when it is created (default CONFIG.host). */
    host?: string;
    /** Test hook: runs after a batch is parsed, before its transaction starts. */
    beforeCommit?: () => void;
}
export type IndexStatus = "unchanged" | "indexed" | "raced" | "missing";
export interface IndexFileResult {
    status: IndexStatus;
    /** True when the file was indexed again from zero (shrank or was replaced). */
    reset: boolean;
    messagesAdded: number;
    bytesRead: number;
    /** False when a deadline stopped indexing before the end of the file. */
    complete: boolean;
    /** Claude lines skipped as already indexed (see indexing/line-keys.ts). */
    duplicates: DuplicateLines;
    sessionSid?: number;
}
export interface DuplicateLines {
    /** Held by this session: the twin of this file under another project path, or a repeat in this file. */
    sameSession: number;
    /** Held by another session: history a fork or sibling subagent copied. */
    otherSession: number;
    /** Indexed before schema v3 from another file of this session (no uuid recorded then). */
    beforeUpgrade: number;
}
export declare function noDuplicates(): DuplicateLines;
/** Tool calls still waiting for their results: own-tool ids, and Codex calls in order. */
interface PendingTools {
    own: string[];
    textCalls: boolean[];
}
export declare function parsePendingTools(raw: string | null | undefined): PendingTools;
interface PendingRow {
    rowid?: number;
    seq: number;
    role: Role;
    ts: number | null;
    msgId: string | null;
    prose: string;
    toolInput: string;
    toolOutput: string;
    tools: string[];
    dirty: boolean;
}
interface SessionUpdate {
    gitRemote: string | null;
    minTs: number | null;
    maxTs: number | null;
    added: number;
    cwd: string | null;
    branch: string | null;
    firstPrompt: string | null;
    aiTitle: string | null;
    customTitle: string | null;
    /** 1 when a line at the session's own cwd carried git evidence: a real branch (not HEAD) or a remote (only ever raises cwd_git). */
    cwdGit: number;
    /**
     * The cwd, branch and remote of lines skipped because another session holds them (a fork's
     * copied history): used only while the session's own lines have not stated them (see updateSession).
     */
    copiedCwd: string | null;
    copiedBranch: string | null;
    copiedGitRemote: string | null;
    copiedCwdGit: number;
}
/**
 * Builds message rows from transcript lines. Holds the last row open so that the next
 * line (another block of the same assistant turn, or a tool result) can extend it.
 */
export declare class RowBuilder {
    pending: PendingRow | null;
    private nextSeq;
    private hasFirstPrompt;
    readonly calls: PendingTools;
    readonly finished: PendingRow[];
    update: SessionUpdate;
    /**
     * The session's own cwd: the stored one when the session has it, else the first cwd read. Git
     * evidence counts for it only from a line at that cwd, since a session that started in a
     * folder and moved into a repository records the folder as its cwd and the repository's branch.
     */
    sessionCwd: string | null;
    constructor(pending: PendingRow | null, nextSeq: number, hasFirstPrompt: boolean, calls: PendingTools);
    /** False for the result of a call to this server's own tools. */
    private keepResult;
    private start;
    private noteTime;
    /**
     * Where a line was written (cwd and git branch) as session metadata. Never its time or prompt.
     */
    private noteContext;
    /**
     * Where a line skipped because another session holds it was written: a fallback for a fork
     * whose own lines do not say (a session's own lines always win, see updateSession).
     */
    noteCopied(obj: Record<string, unknown>): void;
    addLine(obj: Record<string, unknown>): void;
    /**
     * Lines were skipped because another session holds them (a fork's copied history): the
     * open row is closed, so a line after the gap starts a row of its own instead of joining
     * one from before it.
     */
    detach(): void;
    /** Rows to write for this batch (finished ones plus the open one), then reset. */
    drain(): PendingRow[];
}
/** True when the file on disk differs from what the files table recorded. */
export declare function hasChanged(file: TranscriptFile, row: {
    size: number;
    mtime: number;
    ino: number;
} | undefined): boolean;
export declare function indexFile(db: DB, file: TranscriptFile, options?: IndexFileOptions): IndexFileResult;
export {};
//# sourceMappingURL=indexer.d.ts.map