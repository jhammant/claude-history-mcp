import { loadParsedSession } from "../knowledge/parsed-session.js";
import { resolveSession } from "../sessions/read-session.js";
import { formatDateTime, projectName } from "../search/format.js";
import { inList, matchProjects } from "./project-match.js";
export function handleGetSessionSummary(db, args) {
    if (!args.session_id && !args.project) {
        return "Please provide either session_id or project.";
    }
    let sid;
    if (args.session_id) {
        const found = resolveSession(db, args.session_id);
        if (found && "ambiguous" in found) {
            return `"${args.session_id}" matches several sessions: ${found.ambiguous.join(", ")}.`;
        }
        sid = found?.sid;
    }
    else if (args.project) {
        const projects = matchProjects(db, args.project);
        if (projects.length) {
            const list = inList(projects);
            const row = db
                .prepare(`SELECT sid FROM sessions WHERE project IN (${list.sql}) AND is_subagent = 0
           ORDER BY end_time DESC LIMIT 1`)
                .get(...list.params);
            sid = row?.sid;
        }
    }
    const session = sid === undefined ? null : loadParsedSession(db, sid);
    if (!session) {
        return args.session_id
            ? `Session ${args.session_id} not found.`
            : `No sessions found for project "${args.project}".`;
    }
    return formatSessionSummary(session);
}
function formatSessionSummary(session) {
    const name = projectName(session.project, session.cwd);
    const startDate = formatDateTime(session.startTime);
    const endDate = formatDateTime(session.endTime);
    const userMessages = session.messages.filter((m) => m.role === "user");
    const assistantMessages = session.messages.filter((m) => m.role === "assistant");
    const allTools = session.messages.flatMap((m) => m.toolNames);
    const uniqueTools = [...new Set(allTools)];
    // Extract first user message as "topic"
    const topic = userMessages.length > 0
        ? userMessages[0].text.slice(0, 200)
        : session.messages[0]?.text.slice(0, 200) || "Unknown topic";
    // Extract key topics from user messages
    const userTexts = userMessages.map((m) => m.text).join(" ");
    const keyPhrases = extractKeyPhrases(userTexts);
    const lines = [
        `## Session Summary: ${name}`,
        "",
        `**Session ID**: ${session.sessionId}`,
        `**Project**: ${name}`,
        `**Branch**: ${session.gitBranch || "unknown"}`,
        `**Time**: ${startDate} → ${endDate}`,
        `**Messages**: ${userMessages.length} user, ${assistantMessages.length} assistant`,
        `**Read it**: read_session(session_id="${session.sessionId}")`,
        "",
        `### Initial Topic`,
        topic,
        "",
    ];
    if (uniqueTools.length > 0) {
        lines.push(`### Tools Used`);
        lines.push(uniqueTools.join(", "));
        lines.push("");
    }
    if (keyPhrases.length > 0) {
        lines.push(`### Key Topics`);
        for (const phrase of keyPhrases.slice(0, 10)) {
            lines.push(`- ${phrase}`);
        }
        lines.push("");
    }
    // Include last few user messages as "conversation flow"
    if (userMessages.length > 1) {
        lines.push(`### Conversation Flow`);
        const recentMessages = userMessages.slice(-5);
        for (const msg of recentMessages) {
            const text = msg.text.length > 150 ? msg.text.slice(0, 150) + "..." : msg.text;
            lines.push(`- ${text}`);
        }
    }
    return lines.join("\n");
}
function extractKeyPhrases(text) {
    // Simple heuristic: find quoted strings, error messages, file paths, and key terms
    const phrases = [];
    // Quoted strings
    const quoted = text.match(/"[^"]{3,50}"/g);
    if (quoted)
        phrases.push(...quoted.map((q) => q.replace(/"/g, "")));
    // Error-like patterns
    const errors = text.match(/(?:error|Error|ERROR|exception|Exception|failed|FAILED)[:\s][^\n.]{5,80}/g);
    if (errors)
        phrases.push(...errors.slice(0, 3));
    return [...new Set(phrases)].slice(0, 10);
}
//# sourceMappingURL=get-session-summary.js.map