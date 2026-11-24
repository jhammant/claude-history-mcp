/**
 *   <claude projects>/<project>/<session>.jsonl                          a session
 *   <claude projects>/<project>/<session>/subagents/**\/agent-<id>.jsonl  its subagents
 *
 * A subagent's session id is agent-<id>@<parent session id>: the same agent file name
 * can appear under two parents (a forked session copies them), and must not merge.
 */
import { basename, join } from "path";
import { CONFIG } from "../config.js";
import { readDir, statFile } from "./fs-util.js";
/** Stored id of a subagent: its file name stem, qualified by the parent session. */
export function subagentSessionId(agentStem, parentSessionId) {
    return `${agentStem}@${parentSessionId}`;
}
export function collectSubagents(dir, projectDir, parentSessionId, out) {
    for (const entry of readDir(dir)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectSubagents(path, projectDir, parentSessionId, out);
        }
        else if (entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) {
            const file = statFile(path, {
                source: "claude",
                format: "claude",
                projectDir,
                sessionId: subagentSessionId(basename(entry.name, ".jsonl"), parentSessionId),
                isSubagent: true,
                parentSessionId,
            });
            if (file)
                out.push(file);
        }
    }
}
/** Claude-shaped lines (the Claude format and the Codex feed): a user or assistant message. */
export function isClaudeShapedMessage(head) {
    return head.includes('"type":"user"') || head.includes('"type":"assistant"');
}
export const claudeFormat = {
    id: "claude",
    source: "claude",
    root: () => CONFIG.projectsDir,
    projectFromContent: false,
    list(root, options) {
        const includeSubagents = options.includeSubagentsOf ?? (() => true);
        const out = [];
        for (const project of readDir(root)) {
            if (!project.isDirectory())
                continue;
            const projectPath = join(root, project.name);
            for (const entry of readDir(projectPath)) {
                const path = join(projectPath, entry.name);
                if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                    const file = statFile(path, {
                        source: "claude",
                        format: "claude",
                        projectDir: project.name,
                        sessionId: basename(entry.name, ".jsonl"),
                        isSubagent: false,
                    });
                    if (file)
                        out.push(file);
                }
                else if (entry.isDirectory() && includeSubagents(entry.name)) {
                    collectSubagents(join(path, "subagents"), project.name, entry.name, out);
                }
            }
        }
        return out;
    },
    isMessageLine: isClaudeShapedMessage,
    translator: () => ({ translate: (obj) => [obj] }),
};
//# sourceMappingURL=claude.js.map