/**
 * Heuristic session summarizer — no LLM needed.
 * Generates structured summaries from parsed session data.
 */

import type { DB } from "../db/database.js";
import type { ParsedSession } from "./parsed-session.js";
import { isLocalCommandEcho } from "../parsers/content-extractor.js";
import { extractProjectName } from "../utils/path-encoder.js";

export interface SessionSummary {
  sessionId: string;
  project: string;
  projectName: string;
  startTime: number;
  endTime: number;
  duration: number; // ms
  messageCount: number;
  userMessageCount: number;
  topic: string;
  keyTopics: string[];
  toolsUsed: string[];
  filesReferenced: string[];
  hasCodeChanges: boolean;
  lastUserMessage: string;
}

/**
 * Generate a heuristic summary for a session.
 */
export function summarizeSession(session: ParsedSession): SessionSummary {
  const userMessages = session.messages.filter((m) => m.role === "user");
  const allTools = [...new Set(session.messages.flatMap((m) => m.toolNames))];
  const allFiles = [
    ...new Set(
      session.messages
        .flatMap((m) => m.toolInputSnippets)
        .filter((s) => s.startsWith("/") || s.includes("."))
    ),
  ];
  const hasCode = session.messages.some((m) => m.hasCode);

  const asked = userMessages.filter((m) => !isLocalCommandEcho(m.text));
  const topic = (asked[0] ?? userMessages[0])?.text.slice(0, 150) ?? "Unknown";

  const keyTopics = extractKeyTopics(
    userMessages.map((m) => m.text).join(" ")
  );

  const lastUserMsg = (asked[asked.length - 1] ?? userMessages[userMessages.length - 1])?.text.slice(0, 150) ?? "";

  return {
    sessionId: session.sessionId,
    project: session.project,
    projectName: extractProjectName(session.project),
    startTime: session.startTime,
    endTime: session.endTime,
    duration: session.endTime - session.startTime,
    messageCount: session.messages.length,
    userMessageCount: userMessages.length,
    topic,
    keyTopics,
    toolsUsed: allTools,
    filesReferenced: allFiles.slice(0, 20),
    hasCodeChanges: hasCode || allTools.includes("Write") || allTools.includes("Edit"),
    lastUserMessage: lastUserMsg,
  };
}

/** Store (or replace) a session's summary. */
export function saveSummary(db: DB, summary: SessionSummary): void {
  db.prepare(
    `INSERT INTO summaries(session_id, project, end_time, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET project = excluded.project, end_time = excluded.end_time, data = excluded.data`
  ).run(summary.sessionId, summary.project, summary.endTime || 0, JSON.stringify(summary));
}

function extractKeyTopics(text: string): string[] {
  const topics = new Set<string>();
  const lower = text.toLowerCase();

  // Look for technology mentions
  const techTerms = [
    "docker", "kubernetes", "react", "typescript", "python", "git",
    "api", "database", "deploy", "test", "debug", "refactor",
    "performance", "security", "auth", "css", "html", "npm",
    "webpack", "vite", "swift", "ios", "android", "linux",
    "nginx", "redis", "postgres", "mongodb", "graphql", "rest",
  ];

  for (const term of techTerms) {
    if (lower.includes(term)) topics.add(term);
  }

  // Look for action verbs
  const actions = [
    "fix", "implement", "add", "remove", "update", "migrate",
    "configure", "setup", "install", "build", "deploy",
  ];
  for (const action of actions) {
    if (lower.includes(action)) topics.add(action);
  }

  return [...topics].slice(0, 10);
}
