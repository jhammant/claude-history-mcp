/**
 * Page through a session's stored messages, including sessions whose transcript file
 * Claude Code has since deleted.
 */

import { existsSync } from "fs";
import type { DB } from "../db/database.js";
import { formatDateTime, projectName } from "../search/format.js";

export interface ReadSessionArgs {
  session_id: string;
  /** Centre the page on this message number. */
  around?: number;
  /** First message number of the page. */
  from?: number;
  /** Last message number of the page (inclusive). */
  to?: number;
  /** Most messages to return (default 20, max 100). */
  limit?: number;
  /** Most characters per message (default 2000). */
  max_chars?: number;
}

export interface SessionRow {
  sid: number;
  id: string;
  project: string;
  cwd: string | null;
  git_branch: string | null;
  source: string;
  is_subagent: number;
  parent_session: string | null;
  title: string | null;
  first_prompt: string | null;
  start_time: number | null;
  end_time: number | null;
  message_count: number;
  legacy: number;
}

const TOTAL_CHAR_BUDGET = 40_000;

/** Find a session by full id, or by an unambiguous prefix of at least 6 characters. */
export function resolveSession(db: DB, idOrPrefix: string): SessionRow | { ambiguous: string[] } | null {
  const id = idOrPrefix.trim();
  const exact = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (exact || id.length < 6) return exact ?? null;
  const like = id.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const matches = db.prepare("SELECT * FROM sessions WHERE id LIKE ? ESCAPE '\\' LIMIT 6").all(like) as SessionRow[];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ambiguous: matches.map((m) => m.id) };
  return null;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + ` … [${text.length - max} more chars]` : text;
}

export function readSession(db: DB, args: ReadSessionArgs): string {
  const found = resolveSession(db, args.session_id ?? "");
  if (!found) return `No session "${args.session_id}" in the history database.`;
  if ("ambiguous" in found) return `"${args.session_id}" matches several sessions: ${found.ambiguous.join(", ")}. Give more of the id.`;
  const session = found;

  const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 20), 100));
  const maxChars = Math.max(200, Math.min(Math.floor(args.max_chars ?? 2_000), 20_000));
  const last = (db.prepare("SELECT max(seq) AS seq FROM messages WHERE session_sid = ?").get(session.sid) as { seq: number | null }).seq ?? -1;

  let from: number;
  let to: number;
  if (args.around !== undefined) {
    from = Math.max(0, Math.floor(args.around) - Math.floor((limit - 1) / 2));
    to = from + limit - 1;
  } else {
    from = Math.max(0, Math.floor(args.from ?? 0));
    to = args.to !== undefined ? Math.min(Math.floor(args.to), from + limit - 1) : from + limit - 1;
  }

  const files = db.prepare("SELECT path FROM files WHERE session_sid = ?").all(session.sid) as Array<{ path: string }>;
  const onDisk = files.some((f) => existsSync(f.path));
  const tags = [session.source];
  if (session.is_subagent) tags.push(`subagent of ${session.parent_session ?? "unknown"}`);
  if (session.legacy) tags.push("archived from the old index (chunks, not messages)");
  tags.push(onDisk ? "transcript on disk" : "transcript deleted, kept in the database");

  const lines = [
    `Session ${session.id} · ${projectName(session.project, session.cwd)}` +
      `${session.git_branch ? ` · branch ${session.git_branch}` : ""}`,
    `${formatDateTime(session.start_time)} → ${formatDateTime(session.end_time)} · ${session.message_count} messages · ${tags.join(" · ")}`,
  ];
  if (session.title) lines.push(`Title: ${session.title}`);
  const subagents = db.prepare("SELECT count(*) AS n FROM sessions WHERE parent_session = ?").get(session.id) as { n: number };
  if (subagents.n > 0) lines.push(`Subagents: ${subagents.n} (search with session:${session.id})`);

  const rows = db
    .prepare(
      `SELECT m.seq, m.role, m.ts, m.tools, t.prose, t.tool_input, t.tool_output
       FROM messages m JOIN message_text t ON t.id = m.id
       WHERE m.session_sid = ? AND m.seq BETWEEN ? AND ? ORDER BY m.seq`
    )
    .all(session.sid, from, to) as Array<{ seq: number; role: string; ts: number | null; tools: string; prose: string; tool_input: string; tool_output: string }>;

  if (rows.length === 0) {
    lines.push("", last < 0 ? "No messages stored for this session." : `No messages in #${from}–#${to}. Messages run #0–#${last}.`);
    return lines.join("\n");
  }

  lines.push(`Showing #${rows[0].seq}–#${rows[rows.length - 1].seq} of #0–#${last}.`, "");
  let budget = TOTAL_CHAR_BUDGET;
  let shownTo = rows[0].seq - 1;
  for (const row of rows) {
    if (budget <= 0) break;
    const tools = row.tools ? ` · tools: ${[...new Set(row.tools.split(" "))].join(", ")}` : "";
    const time = row.ts ? formatDateTime(row.ts).slice(11) : "";
    const block = [`#${row.seq} ${row.role}${time ? ` · ${time}` : ""}${tools}`];
    if (row.prose) block.push(clip(row.prose, maxChars));
    if (row.tool_input) block.push(...clip(row.tool_input, Math.ceil(maxChars / 2)).split("\n").map((l) => `  ▸ ${l}`));
    if (row.tool_output) block.push(`  ⇢ ${clip(row.tool_output.replace(/\n/g, " ⏎ "), Math.ceil(maxChars / 2))}`);
    const text = block.join("\n");
    budget -= text.length;
    lines.push(text, "");
    shownTo = row.seq;
  }

  const nav: string[] = [];
  if (rows[0].seq > 0) nav.push(`earlier: from=${Math.max(0, rows[0].seq - limit)}`);
  if (shownTo < last) nav.push(`later: from=${shownTo + 1}`);
  if (nav.length) lines.push(`More: read_session(session_id="${session.id}", ${nav.join(" | ")})`);
  return lines.join("\n").trimEnd();
}
