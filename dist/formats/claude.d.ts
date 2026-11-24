/**
 *   <claude projects>/<project>/<session>.jsonl                          a session
 *   <claude projects>/<project>/<session>/subagents/**\/agent-<id>.jsonl  its subagents
 *
 * A subagent's session id is agent-<id>@<parent session id>: the same agent file name
 * can appear under two parents (a forked session copies them), and must not merge.
 */
import type { TranscriptFile } from "../parsers/transcript-files.js";
import type { TranscriptFormat } from "./types.js";
/** Stored id of a subagent: its file name stem, qualified by the parent session. */
export declare function subagentSessionId(agentStem: string, parentSessionId: string): string;
export declare function collectSubagents(dir: string, projectDir: string, parentSessionId: string, out: TranscriptFile[]): void;
/** Claude-shaped lines (the Claude format and the Codex feed): a user or assistant message. */
export declare function isClaudeShapedMessage(head: string): boolean;
export declare const claudeFormat: TranscriptFormat;
//# sourceMappingURL=claude.d.ts.map