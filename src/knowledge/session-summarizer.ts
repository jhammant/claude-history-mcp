/**
 * Heuristic session summarizer — no LLM needed.
 * Generates structured summaries from parsed session data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CONFIG } from "../config.js";
import type { ParsedSession } from "../parsers/session-parser.js";
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

  const topic = userMessages.length > 0
    ? userMessages[0].text.slice(0, 150)
    : "Unknown";

  const keyTopics = extractKeyTopics(
    userMessages.map((m) => m.text).join(" ")
  );

  const lastUserMsg = userMessages.length > 0
    ? userMessages[userMessages.length - 1].text.slice(0, 150)
    : "";

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

/**
 * Cache a session summary to disk.
 */
export function cacheSummary(summary: SessionSummary): void {
  const dir = CONFIG.summariesDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${summary.sessionId}.json`);
  writeFileSync(filePath, JSON.stringify(summary, null, 2));
}

/**
 * Load a cached summary.
 */
export function loadCachedSummary(sessionId: string): SessionSummary | null {
  const filePath = join(CONFIG.summariesDir, `${sessionId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
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
