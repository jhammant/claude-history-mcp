/**
 * Find transcript files on disk.
 *
 *   <claude projects>/<project>/<session>.jsonl                          a session
 *   <claude projects>/<project>/<session>/subagents/**\/agent-<id>.jsonl  its subagents
 *
 * A subagent's session id is agent-<id>@<parent session id>: the same agent file name
 * can appear under two parents (a forked session copies them), and must not merge.
 *   <codex feed>/projects/<project>/codex-<id>.jsonl                      a Codex session
 */
export type Source = "claude" | "codex";
export interface TranscriptFile {
    path: string;
    source: Source;
    /** Encoded project directory name, e.g. -work-app. */
    projectDir: string;
    sessionId: string;
    isSubagent: boolean;
    parentSessionId?: string;
    size: number;
    mtimeMs: number;
    ino: number;
}
export interface ListOptions {
    /**
     * Which sessions' subagent directories to walk. Walking all of them costs a few
     * hundred ms on a large history; a caller in a hurry passes a filter.
     */
    includeSubagentsOf?: (parentSessionId: string) => boolean;
}
export declare function transcriptRoots(): Array<{
    dir: string;
    source: Source;
}>;
/** Stored id of a subagent: its file name stem, qualified by the parent session. */
export declare function subagentSessionId(agentStem: string, parentSessionId: string): string;
export declare function listTranscripts(options?: ListOptions): TranscriptFile[];
/** Subagent transcripts of one top-level Claude session file. */
export declare function listSubagentFiles(parent: TranscriptFile): TranscriptFile[];
//# sourceMappingURL=transcript-files.d.ts.map