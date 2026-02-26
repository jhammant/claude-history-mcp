/**
 * Stream-parse session JSONL files from ~/.claude/projects/<encoded-path>/<sessionId>.jsonl
 *
 * Session files contain various message types:
 * - type: "user" — user messages with { message: { role: "user", content: string } }
 * - type: "assistant" — assistant messages with { message: { role: "assistant", content: ContentBlock[] } }
 * - type: "progress" — hook/tool progress events (skip)
 * - type: "file-history-snapshot" — file snapshots (skip)
 *
 * Each message has: parentUuid, uuid, timestamp, cwd, sessionId, type
 */
export interface SessionMessage {
    role: "user" | "assistant";
    text: string;
    toolNames: string[];
    toolInputSnippets: string[];
    hasCode: boolean;
    timestamp: string;
    uuid: string;
}
export interface ParsedSession {
    sessionId: string;
    project: string;
    cwd: string;
    gitBranch: string;
    messages: SessionMessage[];
    startTime: number;
    endTime: number;
}
/**
 * Parse a single session JSONL file.
 */
export declare function parseSessionFile(filePath: string, projectDir: string): ParsedSession | null;
export interface SessionFileInfo {
    filePath: string;
    projectDir: string;
    sessionId: string;
    mtime: number;
    size: number;
}
/**
 * Enumerate all session JSONL files across all projects.
 */
export declare function enumerateSessionFiles(): SessionFileInfo[];
//# sourceMappingURL=session-parser.d.ts.map