/**
 * A whole session as the knowledge extractor and summariser see it, loaded from the
 * database (so it works for sessions whose transcript has been deleted).
 */
const TOOL_LINE = /^[A-Za-z_][\w.-]*: (.+)$/;
export function loadParsedSession(db, sid) {
    const session = db
        .prepare("SELECT id, project, cwd, git_branch, start_time, end_time FROM sessions WHERE sid = ?")
        .get(sid);
    if (!session)
        return null;
    const rows = db
        .prepare(`SELECT m.role, m.ts, m.tools, t.prose, t.tool_input FROM messages m JOIN message_text t ON t.id = m.id
       WHERE m.session_sid = ? ORDER BY m.seq`)
        .all(sid);
    return {
        sessionId: session.id,
        project: session.project,
        cwd: session.cwd ?? "",
        gitBranch: session.git_branch ?? "",
        startTime: session.start_time ?? 0,
        endTime: session.end_time ?? 0,
        messages: rows.map((row) => ({
            role: row.role,
            text: row.prose,
            toolNames: row.tools ? row.tools.split(" ") : [],
            toolInputSnippets: row.tool_input
                .split("\n")
                .map((line) => TOOL_LINE.exec(line)?.[1])
                .filter((detail) => !!detail),
            hasCode: row.prose.includes("```"),
            timestamp: row.ts ? new Date(row.ts).toISOString() : "",
        })),
    };
}
//# sourceMappingURL=parsed-session.js.map