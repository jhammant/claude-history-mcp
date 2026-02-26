/**
 * Extract knowledge entries (decisions, solutions, error fixes, patterns)
 * from parsed session data using heuristic pattern matching.
 */

import { randomUUID } from "crypto";
import type { ParsedSession } from "../parsers/session-parser.js";
import type { KnowledgeEntry } from "./knowledge-store.js";

const DECISION_PATTERNS = [
  /(?:decided to|going with|chose|choosing|we'll use|let's use|switched to|opting for)\s+(.{10,120})/i,
  /(?:decision|approach):\s*(.{10,120})/i,
  /(?:instead of .{5,50}, (?:we|i|let's))\s+(.{10,80})/i,
];

const SOLUTION_PATTERNS = [
  /(?:fixed|solved|resolved|the fix was|the issue was|the problem was|solution was|that worked)\s*[:\s]?\s*(.{10,200})/i,
  /(?:works?(?:ed)? (?:now|correctly|properly|after))\s+(.{10,120})/i,
  /(?:root cause|underlying issue)(?:\s+was)?\s*[:\s]\s*(.{10,200})/i,
];

const ERROR_PATTERNS = [
  /(?:error|Error|ERROR|exception|Exception|ECONNREFUSED|ENOENT|EPERM|EACCES|ETIMEDOUT|SIGKILL|SIGTERM|OOM|segfault|panic|fatal)\s*[:\s]?\s*(.{5,150})/i,
  /(?:failed|failing|broken|crash(?:ed|ing)?|not working)\s*[:\s]?\s*(.{5,100})/i,
];

/**
 * Extract knowledge from a single session.
 */
export function extractKnowledge(session: ParsedSession): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const messages = session.messages;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const text = msg.text;

    // Extract decisions
    for (const pattern of DECISION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        entries.push({
          id: randomUUID(),
          type: "decision",
          project: session.project,
          sessionId: session.sessionId,
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
          summary: match[1].trim().replace(/\.$/, ""),
          details: getContext(messages, i),
          tags: extractTags(text),
          relatedFiles: extractFilePaths(text),
        });
        break; // One per message
      }
    }

    // Extract solutions
    for (const pattern of SOLUTION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        entries.push({
          id: randomUUID(),
          type: "solution",
          project: session.project,
          sessionId: session.sessionId,
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
          summary: match[1].trim().replace(/\.$/, ""),
          details: getContext(messages, i),
          tags: extractTags(text),
          relatedFiles: extractFilePaths(text),
        });
        break;
      }
    }

    // Extract error → fix sequences
    if (msg.role === "user" || msg.role === "assistant") {
      for (const pattern of ERROR_PATTERNS) {
        const match = text.match(pattern);
        if (match && i + 1 < messages.length) {
          // Look ahead for a solution
          const nextMessages = messages.slice(i + 1, i + 4);
          for (const nextMsg of nextMessages) {
            for (const solPattern of SOLUTION_PATTERNS) {
              const solMatch = nextMsg.text.match(solPattern);
              if (solMatch) {
                entries.push({
                  id: randomUUID(),
                  type: "error_fix",
                  project: session.project,
                  sessionId: session.sessionId,
                  timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
                  summary: `${match[1].trim()} → ${solMatch[1].trim()}`.slice(0, 200),
                  details: getContext(messages, i, 3),
                  tags: extractTags(text + " " + nextMsg.text),
                  relatedFiles: extractFilePaths(text + " " + nextMsg.text),
                });
                break;
              }
            }
          }
          break;
        }
      }
    }
  }

  return deduplicateEntries(entries);
}

/**
 * Get context around a message index.
 */
function getContext(
  messages: ParsedSession["messages"],
  index: number,
  windowSize = 2
): string {
  const start = Math.max(0, index - windowSize);
  const end = Math.min(messages.length, index + windowSize + 1);
  return messages
    .slice(start, end)
    .map((m) => {
      const text = m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text;
      return `[${m.role}] ${text}`;
    })
    .join("\n");
}

/**
 * Extract technology/tool tags from text.
 */
function extractTags(text: string): string[] {
  const tags = new Set<string>();
  const techPatterns: Record<string, RegExp> = {
    docker: /\bdocker\b/i,
    typescript: /\btypescript\b|\bts\b/i,
    javascript: /\bjavascript\b|\bjs\b/i,
    react: /\breact\b/i,
    node: /\bnode\.?js?\b/i,
    python: /\bpython\b/i,
    git: /\bgit\b/i,
    npm: /\bnpm\b/i,
    css: /\bcss\b|\bstyle/i,
    api: /\bapi\b|\bendpoint/i,
    database: /\bdatabase\b|\bsql\b|\bpostgres\b|\bmongo\b/i,
    testing: /\btest(?:s|ing)?\b/i,
    deployment: /\bdeploy\b|\bci\/cd\b/i,
    security: /\bsecurity\b|\bauth\b/i,
    performance: /\bperformance\b|\boptimiz/i,
    networking: /\bnetwork\b|\bhttp\b|\btcp\b/i,
    linux: /\blinux\b|\bubuntu\b|\bdebian\b/i,
    macos: /\bmacos\b|\bmac\b/i,
    swift: /\bswift\b|\bswiftui\b/i,
    ios: /\bios\b|\bxcode\b/i,
  };

  for (const [tag, pattern] of Object.entries(techPatterns)) {
    if (pattern.test(text)) tags.add(tag);
  }

  return [...tags];
}

/**
 * Extract file paths from text.
 */
function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  const matches = text.match(/(?:\/[\w.-]+){2,}/g);
  if (matches) {
    for (const match of matches.slice(0, 5)) {
      paths.add(match);
    }
  }
  return [...paths];
}

/**
 * Remove near-duplicate entries.
 */
function deduplicateEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.type}:${e.summary.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
