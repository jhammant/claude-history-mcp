#!/usr/bin/env node

/**
 * Session-start hook: auto-inject project context in Claude Code and Codex.
 *
 * Reads the latest session summaries and extracted knowledge for the current project
 * from the history database (indexed queries, read-only) and prints one hook JSON
 * object to stdout. Prints nothing when there is no context, and exits silently when
 * the database is missing, locked or unreadable. Target: well under 200 ms.
 *
 * Register as a SessionStart command hook in Claude Code or Codex.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { CONFIG } from "../config.js";
import { encodeProjectPath, extractProjectName } from "../utils/path-encoder.js";

interface SummaryRow {
  data: string;
}

function timeAgo(endTime: number): string {
  const daysAgo = Math.floor((Date.now() - endTime) / 86_400_000);
  return daysAgo <= 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
}

function buildContext(db: Database.Database, cwd: string): string | null {
  const projectDir = encodeProjectPath(cwd);
  // The project's own dir and any dir beneath it, newest first, via the (project, ...) indexes.
  const upper = projectDir + "￿";
  const summaries = (
    db
      .prepare("SELECT data FROM summaries WHERE project >= ? AND project < ? ORDER BY end_time DESC LIMIT 3")
      .all(projectDir, upper) as SummaryRow[]
  ).flatMap((row) => {
    try {
      const summary = JSON.parse(row.data) as { topic?: unknown; endTime?: unknown };
      return typeof summary.topic === "string" ? [{ topic: summary.topic, endTime: Number(summary.endTime) || 0 }] : [];
    } catch {
      return [];
    }
  });
  const knowledge = db.prepare(
    "SELECT summary FROM knowledge WHERE project >= ? AND project < ? AND type = ? ORDER BY ts DESC LIMIT ?"
  );
  const of = (type: string, limit: number) =>
    (knowledge.all(projectDir, upper, type, limit) as Array<{ summary: string }>).map((k) => k.summary);

  const lines = [`[ClaudeHistory] Previous context for ${extractProjectName(cwd)}:`];
  for (const summary of summaries) {
    const topic = summary.topic.length > 80 ? summary.topic.slice(0, 80) + "..." : summary.topic;
    lines.push(`- Last session (${timeAgo(summary.endTime)}): ${topic}`);
  }
  for (const d of of("decision", 2)) lines.push(`- Key decision: ${d}`);
  for (const s of of("solution", 2)) lines.push(`- Solution found: ${s}`);
  for (const e of of("error_fix", 1)) lines.push(`- Error fix: ${e}`);
  return lines.length > 1 ? lines.join("\n") : null;
}

function main(): void {
  let db: Database.Database | undefined;
  try {
    const path = CONFIG.databaseFile;
    if (!existsSync(path)) return;
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 50 });
    const context = buildContext(db, process.cwd());
    if (context) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      }));
    }
  } catch {
    // Missing, locked or damaged database: no context this time, and never an error.
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

main();
