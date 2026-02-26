/**
 * Parse ~/.claude/history.jsonl — the global history index.
 * Each line is a JSON object with: display, pastedContents, timestamp, project, sessionId
 */
import { readFileSync, existsSync } from "fs";
import { CONFIG } from "../config.js";
/**
 * Parse the global history file and return all entries.
 * Groups entries by sessionId for efficient lookup.
 */
export function parseHistoryFile() {
    const filePath = CONFIG.historyFile;
    if (!existsSync(filePath))
        return [];
    const entries = [];
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const obj = JSON.parse(line);
            if (obj.sessionId && obj.project) {
                entries.push({
                    display: obj.display || "",
                    timestamp: obj.timestamp || 0,
                    project: obj.project || "",
                    sessionId: obj.sessionId || "",
                });
            }
        }
        catch {
            // Skip malformed lines
        }
    }
    return entries;
}
/**
 * Group history entries by session ID.
 */
export function groupBySession(entries) {
    const groups = new Map();
    for (const entry of entries) {
        const group = groups.get(entry.sessionId);
        if (group) {
            group.push(entry);
        }
        else {
            groups.set(entry.sessionId, [entry]);
        }
    }
    return groups;
}
/**
 * Group history entries by project path.
 */
export function groupByProject(entries) {
    const groups = new Map();
    for (const entry of entries) {
        const group = groups.get(entry.project);
        if (group) {
            group.push(entry);
        }
        else {
            groups.set(entry.project, [entry]);
        }
    }
    return groups;
}
/**
 * Get summary info for all projects.
 */
export function getProjectInfos(entries) {
    const byProject = groupByProject(entries);
    const infos = [];
    for (const [project, projectEntries] of byProject) {
        const sessions = new Set(projectEntries.map((e) => e.sessionId));
        const timestamps = projectEntries.map((e) => e.timestamp).filter(Boolean);
        infos.push({
            path: project,
            sessionCount: sessions.size,
            firstActivity: timestamps.length > 0 ? Math.min(...timestamps) : 0,
            lastActivity: timestamps.length > 0 ? Math.max(...timestamps) : 0,
            messageCount: projectEntries.length,
        });
    }
    return infos;
}
//# sourceMappingURL=history-parser.js.map