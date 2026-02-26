/**
 * Heuristic session summarizer — no LLM needed.
 * Generates structured summaries from parsed session data.
 */
import type { ParsedSession } from "../parsers/session-parser.js";
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
/**
 * Cache a session summary to disk.
 */
export declare function cacheSummary(summary: SessionSummary): void;
/**
 * Load a cached summary.
 */
export declare function loadCachedSummary(sessionId: string): SessionSummary | null;
//# sourceMappingURL=session-summarizer.d.ts.map