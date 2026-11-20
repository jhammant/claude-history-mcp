/**
 * A whole session as the knowledge extractor and summariser see it, loaded from the
 * database (so it works for sessions whose transcript has been deleted).
 */

import type { DB } from "../db/database.js";

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "mixed";
  text: string;
  toolNames: string[];
  /** The detail of each tool call: a command, a path, a pattern. */
  toolInputSnippets: string[];
  hasCode: boolean;
  timestamp: string;
}

export interface ParsedSession {
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch: string;
  messages: SessionMessage[];
  startTime: number;
  endTime: number;
}

const TOOL_LINE = /^[A-Za-z_][\w.-]*: (.+)$/;

export function loadParsedSession(db: DB, sid: number): ParsedSession | null {
  const session = db
    .prepare("SELECT id, project, cwd, git_branch, start_time, end_time FROM sessions WHERE sid = ?")
    .get(sid) as
    | { id: string; project: string; cwd: string | null; git_branch: string | null; start_time: number | null; end_time: number | null }
    | undefined;
  if (!session) return null;

  const rows = db
    .prepare(
      `SELECT m.role, m.ts, m.tools, t.prose, t.tool_input FROM messages m JOIN message_text t ON t.id = m.id
       WHERE m.session_sid = ? ORDER BY m.seq`
    )
    .all(sid) as Array<{ role: SessionMessage["role"]; ts: number | null; tools: string; prose: string; tool_input: string }>;

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
        .filter((detail): detail is string => !!detail),
      hasCode: row.prose.includes("```"),
      timestamp: row.ts ? new Date(row.ts).toISOString() : "",
    })),
  };
}
