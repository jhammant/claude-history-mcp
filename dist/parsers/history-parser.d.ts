/**
 * Parse ~/.claude/history.jsonl — the global history index.
 * Each line is a JSON object with: display, pastedContents, timestamp, project, sessionId
 */
export interface HistoryEntry {
    display: string;
    timestamp: number;
    project: string;
    sessionId: string;
}
/**
 * Parse the global history file and return all entries.
 * Groups entries by sessionId for efficient lookup.
 */
export declare function parseHistoryFile(): HistoryEntry[];
/**
 * Group history entries by session ID.
 */
export declare function groupBySession(entries: HistoryEntry[]): Map<string, HistoryEntry[]>;
/**
 * Group history entries by project path.
 */
export declare function groupByProject(entries: HistoryEntry[]): Map<string, HistoryEntry[]>;
export interface ProjectInfo {
    path: string;
    sessionCount: number;
    firstActivity: number;
    lastActivity: number;
    messageCount: number;
}
/**
 * Get summary info for all projects.
 */
export declare function getProjectInfos(entries: HistoryEntry[]): ProjectInfo[];
//# sourceMappingURL=history-parser.d.ts.map