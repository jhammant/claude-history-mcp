/**
 * Heuristic session summarizer — no LLM needed.
 * Generates structured summaries from parsed session data.
 */
import type { DB } from "../db/database.js";
import type { ParsedSession } from "./parsed-session.js";
export interface SessionSummary {
    sessionId: string;
    project: string;
    projectName: string;
    startTime: number;
    endTime: number;
    duration: number;
    messageCount: number;
    userMessageCount: number;
    topic: string;
    keyTopics: string[];
    toolsUsed: string[];
    filesReferenced: string[];
    hasCodeChanges: boolean;
    lastUserMessage: string;
}
/**
 * Generate a heuristic summary for a session.
 */
export declare function summarizeSession(session: ParsedSession): SessionSummary;
/** Store (or replace) a session's summary. */
export declare function saveSummary(db: DB, summary: SessionSummary): void;
//# sourceMappingURL=session-summarizer.d.ts.map