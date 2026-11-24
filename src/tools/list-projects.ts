import { SOURCES, SOURCE_LABELS, type Source } from "../formats/types.js";
import type { DB } from "../db/database.js";
import { formatDateTime, projectName } from "../search/format.js";
import { decodeProjectPath } from "../utils/path-encoder.js";

interface ProjectRow {
  project: string;
  cwd: string | null;
  sessions: number;
  subagents: number;
  messages: number;
  first: number | null;
  last: number | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

/**
 * Projects with history, newest first by default. Capped, because a long-lived database
 * holds hundreds of projects and the caller is a model with a context budget. Sessions with
 * no messages (empty Codex guardian-review threads) are left out of the rows and their counts.
 */
export function handleListProjects(db: DB, args: { sort_by?: string; limit?: number; query?: string }): string {
  const all = db
    .prepare(
      `SELECT project, max(cwd) AS cwd,
         sum(is_subagent = 0) AS sessions, sum(is_subagent) AS subagents,
         sum(message_count) AS messages, min(start_time) AS first, max(end_time) AS last
       FROM sessions WHERE message_count > 0 GROUP BY project`
    )
    .all() as ProjectRow[];
  // Per source: top-level sessions with at least one message, so the breakdown matches the headline's scope.
  const sourceRows = db
    .prepare(
      `SELECT project, source, count(*) AS n FROM sessions WHERE message_count > 0 AND is_subagent = 0
       GROUP BY project, source`
    )
    .all() as Array<{ project: string; source: string; n: number }>;
  const bySource = new Map<string, Map<string, number>>();
  for (const r of sourceRows) {
    if (!bySource.has(r.project)) bySource.set(r.project, new Map());
    bySource.get(r.project)!.set(r.source, r.n);
  }
  if (all.length === 0) return "No projects with conversation history found.";

  const query = args.query?.trim().toLowerCase();
  const rows = query
    ? all.filter((r) => r.project.toLowerCase().includes(query) || (r.cwd ?? "").toLowerCase().includes(query))
    : all;
  if (rows.length === 0) return `No projects match "${args.query}" (${all.length} projects have history).`;

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
      ...sourceCounts(bySource.get(row.project)),
    ].filter(Boolean);
    lines.push(
      `- ${projectName(row.project, row.cwd)} — ${row.sessions} sessions, ${row.messages} messages` +
        (extras.length ? ` (${extras.join(", ")})` : "")
    );
    if (!row.cwd) lines.push(`  Path (decoded, approximate): ${decodeProjectPath(row.project)}`);
    lines.push(`  Active: ${formatDateTime(row.first).slice(0, 10)} → ${formatDateTime(row.last).slice(0, 10)}`);
  }
  if (shown.length < rows.length) {
    lines.push("", `${rows.length - shown.length} more not shown. Narrow with query, or raise limit (max ${MAX_LIMIT}).`);
  }
  return lines.join("\n");
}

/** "2 Claude", "1 pi" for each source present; nothing when the project is all Claude (the default, no need to say). */
function sourceCounts(counts: Map<string, number> | undefined): string[] {
  const present = SOURCES.filter((s: Source) => (counts?.get(s) ?? 0) > 0);
  if (present.length === 0 || (present.length === 1 && present[0] === "claude")) return [];
  return present.map((s) => `${counts!.get(s)} ${SOURCE_LABELS[s]}`);
}
