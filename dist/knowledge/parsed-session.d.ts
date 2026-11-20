/**
 * A whole session as the knowledge extractor and summariser see it, loaded from the
 * database (so it works for sessions whose transcript has been deleted).
 */
import type { DB } from "../db/database.js";
export interface SessionMessage {
    role: "user" | "assistant" | "tool" | "mixed";
    text: string;
    toolNames: string[];
    /** The detail of each tool call: a command, a path, a pattern. */
    toolInputSnippets: string[];
    hasCode: boolean;
    timestamp: string;
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
export declare function loadParsedSession(db: DB, sid: number): ParsedSession | null;
//# sourceMappingURL=parsed-session.d.ts.map