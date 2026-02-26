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
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { CONFIG } from "../config.js";
import { extractContent, stripSystemReminders, } from "./content-extractor.js";
/**
 * Parse a single session JSONL file.
 */
export function parseSessionFile(filePath, projectDir) {
    if (!existsSync(filePath))
        return null;
    const sessionId = basename(filePath, ".jsonl");
    let cwd = "";
    let gitBranch = "";
    const messages = [];
    let startTime = Infinity;
    let endTime = 0;
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue; // Skip malformed lines
        }
        const type = obj.type;
        const timestamp = obj.timestamp;
        // Track time range
        if (timestamp) {
            const ts = typeof timestamp === "number"
                ? timestamp
                : new Date(timestamp).getTime();
            if (ts < startTime)
                startTime = ts;
            if (ts > endTime)
                endTime = ts;
        }
        // Extract cwd and branch from any message that has them
        if (obj.cwd && typeof obj.cwd === "string" && !cwd)
            cwd = obj.cwd;
        if (obj.gitBranch && typeof obj.gitBranch === "string" && !gitBranch)
            gitBranch = obj.gitBranch;
        if (type === "user") {
            const message = obj.message;
            if (!message)
                continue;
            const rawContent = message.content;
            let text = "";
            if (typeof rawContent === "string") {
                text = stripSystemReminders(rawContent);
            }
            else if (Array.isArray(rawContent)) {
                const extracted = extractContent(rawContent);
                text = extracted.text;
            }
            if (text.trim()) {
                messages.push({
                    role: "user",
                    text,
                    toolNames: [],
                    toolInputSnippets: [],
                    hasCode: text.includes("```"),
                    timestamp: String(timestamp || ""),
                    uuid: obj.uuid || "",
                });
            }
        }
        else if (type === "assistant") {
            const message = obj.message;
            if (!message)
                continue;
            const extracted = extractContent(message.content);
            if (extracted.text.trim() || extracted.toolNames.length > 0) {
                messages.push({
                    role: "assistant",
                    text: extracted.text,
                    toolNames: extracted.toolNames,
                    toolInputSnippets: extracted.toolInputSnippets,
                    hasCode: extracted.hasCode,
                    timestamp: String(timestamp || ""),
                    uuid: obj.uuid || "",
                });
            }
        }
        // Skip progress, file-history-snapshot, and other types
    }
    if (messages.length === 0)
        return null;
    return {
        sessionId,
        project: projectDir,
        cwd,
        gitBranch,
        messages,
        startTime: startTime === Infinity ? 0 : startTime,
        endTime,
    };
}
/**
 * Enumerate all session JSONL files across all projects.
 */
export function enumerateSessionFiles() {
    const projectsDir = CONFIG.projectsDir;
    if (!existsSync(projectsDir))
        return [];
    const results = [];
    for (const projectDir of readdirSync(projectsDir)) {
        const projectPath = join(projectsDir, projectDir);
        let stat;
        try {
            stat = statSync(projectPath);
        }
        catch {
            continue;
        }
        if (!stat.isDirectory())
            continue;
        for (const file of readdirSync(projectPath)) {
            if (!file.endsWith(".jsonl"))
                continue;
            const filePath = join(projectPath, file);
            try {
                const fstat = statSync(filePath);
                if (!fstat.isFile())
                    continue;
                results.push({
                    filePath,
                    projectDir,
                    sessionId: basename(file, ".jsonl"),
                    mtime: fstat.mtimeMs,
                    size: fstat.size,
                });
            }
            catch {
                continue;
            }
        }
    }
    return results;
}
//# sourceMappingURL=session-parser.js.map