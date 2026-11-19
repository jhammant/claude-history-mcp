import type { DB } from "../db/database.js";
import { projectKnowledge } from "../knowledge/knowledge-store.js";
import { formatDateTime, projectName } from "../search/format.js";
import { encodeProjectPath } from "../utils/path-encoder.js";
import { inList, matchProjects } from "./project-match.js";

interface SessionRow {
  id: string;
  project: string;
  cwd: string | null;
  title: string | null;
  first_prompt: string | null;
  end_time: number | null;
  message_count: number;
}

function daysAgo(ms: number | null): string {
  if (!ms) return "unknown";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

export function handleGetProjectContext(db: DB, args: { project?: string; depth?: string }, cwd = process.cwd()): string {
  const query = args.project?.trim() || cwd;
  const depth = args.depth ?? "normal";
  const projects = args.project?.trim() ? matchProjects(db, query) : matchProjects(db, encodeProjectPath(cwd));
  if (projects.length === 0) return `No history found for project "${query}".`;

  const list = inList(projects);
  const totals = db
    .prepare(
      `SELECT count(*) AS sessions, sum(message_count) AS messages, max(cwd) AS cwd
       FROM sessions WHERE project IN (${list.sql}) AND is_subagent = 0`
    )
    .get(...list.params) as { sessions: number; messages: number | null; cwd: string | null };
  const sessionCount = depth === "brief" ? 1 : depth === "detailed" ? 5 : 3;
  const recent = db
    .prepare(
      `SELECT id, project, cwd, title, first_prompt, end_time, message_count FROM sessions
       WHERE project IN (${list.sql}) AND is_subagent = 0 ORDER BY end_time DESC LIMIT ?`
    )
    .all(...list.params, sessionCount) as SessionRow[];

  const lines = [
    `## Project Context: ${projectName(projects[0], totals.cwd)}`,
    "",
    `**Total sessions**: ${totals.sessions}`,
    `**Total messages**: ${totals.messages ?? 0}`,
  ];
  if (projects.length > 1) lines.push(`**Matched projects**: ${projects.length} (${projects.slice(0, 5).join(", ")}${projects.length > 5 ? ", …" : ""})`);
  lines.push("", "### Recent Sessions");
  for (const s of recent) {
    const topic = (s.title || s.first_prompt || "Unknown topic").replace(/\s+/g, " ");
    lines.push(`- **${formatDateTime(s.end_time).slice(0, 10)}** (${daysAgo(s.end_time)}): ${topic.length > 120 ? topic.slice(0, 120) + "..." : topic}`);
    lines.push(`  Session: ${s.id} — ${s.message_count} messages`);
  }

  const perType = depth === "detailed" ? 5 : depth === "brief" ? 1 : 2;
  const knowledge = projects.slice(0, 5).flatMap((p) => [
    ...projectKnowledge(db, p, "decision", perType),
    ...projectKnowledge(db, p, "solution", perType),
    ...projectKnowledge(db, p, "error_fix", perType),
  ]);
  if (knowledge.length) {
    lines.push("", "### Decisions and Fixes");
    const label = { decision: "Decision", solution: "Solution", error_fix: "Error fix", pattern: "Pattern" } as const;
    for (const k of knowledge.sort((a, b) => b.timestamp - a.timestamp).slice(0, perType * 3)) {
      lines.push(`- ${label[k.type]}: ${k.summary}`);
    }
  }

  if (depth === "detailed") {
    const prompts = db
      .prepare(
        `SELECT t.prose FROM messages m JOIN sessions s ON s.sid = m.session_sid JOIN message_text t ON t.id = m.id
         WHERE s.project IN (${list.sql}) AND s.is_subagent = 0 AND m.role = 'user'
         ORDER BY m.ts DESC LIMIT 5000`
      )
      .all(...list.params) as Array<{ prose: string }>;
    const wordFreq = new Map<string, number>();
    for (const { prose } of prompts) {
      for (const word of prose.toLowerCase().split(/\s+/)) {
        if (word.length > 4) wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
    }
    lines.push("", "### Common Topics");
    for (const [word, count] of [...wordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      lines.push(`- "${word}" (${count} mentions)`);
    }
  }

  return lines.join("\n");
}
