#!/usr/bin/env node
/**
 * Session-start hook: auto-inject project context on new Claude Code session.
 *
 * Reads pre-computed summaries and knowledge directly from ~/.claude-history-mcp/
 * and outputs brief context to stdout. Target: <200ms.
 *
 * Register in ~/.claude/settings.json as a SessionStart hook.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { encodeProjectPath, extractProjectName } from "../utils/path-encoder.js";
import { CONFIG } from "../config.js";
function main() {
    const cwd = process.cwd();
    const projectDir = encodeProjectPath(cwd);
    const projectName = extractProjectName(cwd);
    // Load recent summaries for this project
    const summaries = loadProjectSummaries(projectDir);
    const knowledge = loadProjectKnowledge(projectDir);
    if (summaries.length === 0 && knowledge.length === 0) {
        // No context to inject
        return;
    }
    const lines = [`[ClaudeHistory] Previous context for ${projectName}:`];
    // Show last 3 session summaries
    for (const summary of summaries.slice(0, 3)) {
        const daysAgo = Math.floor((Date.now() - summary.endTime) / 86400000);
        const timeStr = daysAgo === 0
            ? "today"
            : daysAgo === 1
                ? "yesterday"
                : `${daysAgo} days ago`;
        const topic = summary.topic.length > 80
            ? summary.topic.slice(0, 80) + "..."
            : summary.topic;
        lines.push(`- Last session (${timeStr}): ${topic}`);
    }
    // Show key decisions/solutions
    const decisions = knowledge.filter((k) => k.type === "decision").slice(0, 2);
    for (const d of decisions) {
        lines.push(`- Key decision: ${d.summary}`);
    }
    const solutions = knowledge.filter((k) => k.type === "solution").slice(0, 2);
    for (const s of solutions) {
        lines.push(`- Solution found: ${s.summary}`);
    }
    // Show unresolved issues (errors without fixes)
    const errorFixes = knowledge.filter((k) => k.type === "error_fix").slice(0, 1);
    for (const ef of errorFixes) {
        lines.push(`- Error fix: ${ef.summary}`);
    }
    if (lines.length > 1) {
        console.log(lines.join("\n"));
    }
}
function loadProjectSummaries(projectDir) {
    const summariesDir = CONFIG.summariesDir;
    if (!existsSync(summariesDir))
        return [];
    const summaries = [];
    try {
        for (const file of readdirSync(summariesDir)) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const data = JSON.parse(readFileSync(join(summariesDir, file), "utf-8"));
                if (data.project === projectDir || data.project.includes(projectDir)) {
                    summaries.push(data);
                }
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return [];
    }
    return summaries.sort((a, b) => b.endTime - a.endTime);
}
function loadProjectKnowledge(projectDir) {
    if (!existsSync(CONFIG.knowledgeFile))
        return [];
    try {
        const entries = JSON.parse(readFileSync(CONFIG.knowledgeFile, "utf-8"));
        return entries
            .filter((e) => e.project === projectDir || e.project.includes(projectDir))
            .sort((a, b) => b.timestamp - a.timestamp);
    }
    catch {
        return [];
    }
}
main();
//# sourceMappingURL=session-start-hook.js.map