import { formatDateTime, projectName } from "../search/format.js";
import { decodeProjectPath } from "../utils/path-encoder.js";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
/**
 * Projects with history, newest first by default. Capped, because a long-lived database
 * holds hundreds of projects and the caller is a model with a context budget.
 */
export function handleListProjects(db, args) {
    const all = db
        .prepare(`SELECT project, max(cwd) AS cwd,
         sum(is_subagent = 0) AS sessions, sum(is_subagent) AS subagents, sum(source = 'codex') AS codex,
         sum(message_count) AS messages, min(start_time) AS first, max(end_time) AS last
       FROM sessions GROUP BY project`)
        .all();
    if (all.length === 0)
        return "No projects with conversation history found.";
    const query = args.query?.trim().toLowerCase();
    const rows = query
        ? all.filter((r) => r.project.toLowerCase().includes(query) || (r.cwd ?? "").toLowerCase().includes(query))
        : all;
    if (rows.length === 0)
        return `No projects match "${args.query}" (${all.length} projects have history).`;
    switch (args.sort_by ?? "recent") {
        case "sessions":
            rows.sort((a, b) => b.sessions - a.sessions);
            break;
        case "messages":
            rows.sort((a, b) => b.messages - a.messages);
            break;
        case "name":
            rows.sort((a, b) => projectName(a.project, a.cwd).localeCompare(projectName(b.project, b.cwd)));
            break;
        default:
            rows.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    }
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
    const shown = rows.slice(0, limit);
    const lines = [
        `${rows.length} project${rows.length === 1 ? "" : "s"} with conversation history` +
            (query ? ` matching "${args.query}"` : "") +
            (shown.length < rows.length ? `, showing ${shown.length}:` : ":"),
        "",
    ];
    for (const row of shown) {
        const extras = [
            row.subagents ? `${row.subagents} subagent runs` : "",
            row.codex ? `${row.codex} Codex` : "",
        ].filter(Boolean);
        lines.push(`- ${projectName(row.project, row.cwd)} — ${row.sessions} sessions, ${row.messages} messages` +
            (extras.length ? ` (${extras.join(", ")})` : ""));
        if (!row.cwd)
            lines.push(`  Path (decoded, approximate): ${decodeProjectPath(row.project)}`);
        lines.push(`  Active: ${formatDateTime(row.first).slice(0, 10)} → ${formatDateTime(row.last).slice(0, 10)}`);
    }
    if (shown.length < rows.length) {
        lines.push("", `${rows.length - shown.length} more not shown. Narrow with query, or raise limit (max ${MAX_LIMIT}).`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=list-projects.js.map