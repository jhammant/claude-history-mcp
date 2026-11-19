/**
 * MCP server: a thin reader of the shared history database. No index is held in
 * memory and nothing runs between tool calls.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "module";
import { z } from "zod";
import { CONFIG } from "./config.js";
import { DatabaseMissingError, DatabaseOutdatedError, openDatabase, type DB } from "./db/database.js";
import { topUp } from "./indexing/sweep.js";
import { SearchEngine } from "./search/search-engine.js";
import { readSession } from "./sessions/read-session.js";
import { handleFindPatterns } from "./tools/find-patterns.js";
import { handleFindSolutions } from "./tools/find-solutions.js";
import { handleGetProjectContext } from "./tools/get-project-context.js";
import { handleGetSessionSummary } from "./tools/get-session-summary.js";
import { handleListProjects } from "./tools/list-projects.js";
import { handleSearchHistory } from "./tools/search-history.js";
import { encodeProjectPath } from "./utils/path-encoder.js";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** The command a user runs to build or refresh the database, as this install was started. */
export function sweepCommand(): string {
  const entry = process.argv[1] && /index\.(js|ts)$/.test(process.argv[1]) ? process.argv[1] : "dist/index.js";
  return `node ${entry} sweep`;
}

function missingDatabaseMessage(path: string): string {
  return [
    `The history database has not been built yet (expected at ${path}).`,
    `Build it once with:  ${sweepCommand()}`,
    "A large history takes a few minutes; after that a scheduled sweep keeps it fresh.",
  ].join("\n");
}

/** Query-time freshness: a bounded top-up at most once per interval per process. */
class Freshness {
  private lastRun = 0;
  private behind = 0;

  line(db: DB): string | undefined {
    const now = Date.now();
    if (now - this.lastRun >= CONFIG.topUpIntervalMs) {
      this.lastRun = now;
      try {
        this.behind = topUp(db).behind;
      } catch {
        // a read-only or busy database: answer from what is there
      }
    }
    if (this.behind === 0) return undefined;
    return `index: ${this.behind} changed transcript${this.behind === 1 ? "" : "s"} not yet indexed (they are picked up by later searches or \`${sweepCommand()}\`)`;
  }
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function createServer(options: { cwd?: string } = {}): { server: McpServer; close: () => void } {
  const cwd = options.cwd ?? process.cwd();
  const currentProject = encodeProjectPath(cwd);
  const server = new McpServer({ name: "claude-history-mcp", version: VERSION }, { capabilities: { tools: {} } });
  const freshness = new Freshness();
  let db: DB | null = null;

  function withDatabase(run: (db: DB) => string): ToolResult {
    let text: string;
    try {
      db ??= openDatabase(CONFIG.databaseFile, { migrate: false });
      text = run(db);
    } catch (error) {
      if (error instanceof DatabaseMissingError) text = missingDatabaseMessage(error.path);
      else if (error instanceof DatabaseOutdatedError) text = `${error.message} Upgrade it with:  ${sweepCommand()}`;
      else text = `claude-history error: ${(error as Error).message}`;
    }
    return { content: [{ type: "text", text }] };
  }

  const close = () => {
    db?.close();
    db = null;
  };
  server.server.onclose = close;

  server.tool(
    "search_history",
    [
      "Full-text search of past Claude Code and Codex conversations (prose, commands, file paths, tool output).",
      "Returns one line per session: project, date, session id, role and message number, and a snippet around the matched words (**bold**).",
      "Query tips: all words must match (falls back to partial matches when too few); \"quoted phrase\"; a OR b;",
      "identifiers like index.msgpack, ERR_SQLITE_ERROR or src/server.ts work as typed.",
      "Filters in the query: project:name branch:name tool:Bash role:user|assistant|tool source:claude|codex",
      "session:<id> after:7d before:2026-01-15 (h/d/w/m/y or ISO dates).",
      "Then call read_session(session_id, around=<#>) to read what happened.",
    ].join(" "),
    {
      query: z.string().describe("Search words, phrases and filters, e.g. 'sqlite busy timeout project:myapp after:30d'"),
      project: z.string().optional().describe("Limit to a project (name, part of a name, or path)"),
      limit: z.number().optional().describe("Most sessions to return (default 10, max 50)"),
      include_context: z.boolean().optional().describe("Also show the message just before and after each hit (default false)"),
      sort: z.enum(["relevance", "recent"]).optional().describe("relevance (default) or recent (newest first)"),
    },
    async (args) =>
      withDatabase((db) =>
        handleSearchHistory(new SearchEngine(db), args, { currentProject, freshness: freshness.line(db) })
      )
  );

  server.tool(
    "read_session",
    "Read the messages of one past session from the history database, a page at a time: by message number (around=#), or a range (from/to). Works for sessions whose transcript file has been deleted. Use the session id and # from search_history.",
    {
      session_id: z.string().describe("Session id (or a unique prefix of at least 6 characters)"),
      around: z.number().optional().describe("Centre the page on this message number"),
      from: z.number().optional().describe("First message number to show"),
      to: z.number().optional().describe("Last message number to show"),
      limit: z.number().optional().describe("Most messages per page (default 20, max 100)"),
      max_chars: z.number().optional().describe("Most characters shown per message (default 2000)"),
    },
    async (args) =>
      withDatabase((db) => {
        freshness.line(db);
        return readSession(db, args);
      })
  );

  server.tool(
    "list_projects",
    "List projects with Claude Code or Codex history: sessions, messages, subagent runs and active dates.",
    {
      sort_by: z.enum(["recent", "sessions", "messages", "name"]).optional().describe("Sort order (default: recent)"),
      limit: z.number().optional().describe("Maximum projects to list (default: 30, max: 200)"),
      query: z.string().optional().describe("Only projects whose path contains this text"),
    },
    async (args) => withDatabase((db) => handleListProjects(db, args))
  );

  server.tool(
    "find_solutions",
    "Find how an error or problem was solved before. Pass the error text (an error code or the key line works best); hits whose session goes on to say it was fixed rank first, plus any extracted fixes.",
    {
      error_or_problem: z.string().describe("The error message, problem description, or issue to find solutions for"),
      technology: z.string().optional().describe("Optional technology context (e.g., 'docker', 'typescript', 'react')"),
    },
    async (args) =>
      withDatabase((db) =>
        handleFindSolutions(db, new SearchEngine(db), args, { currentProject, freshness: freshness.line(db) })
      )
  );

  server.tool(
    "get_session_summary",
    "Summarise one session: project, branch, time span, tools used, opening request and the last few requests. Give a session id, or a project for its most recent session.",
    {
      session_id: z.string().optional().describe("Specific session id"),
      project: z.string().optional().describe("Project name or path. Returns summary of most recent session."),
    },
    async (args) => withDatabase((db) => handleGetSessionSummary(db, args))
  );

  server.tool(
    "get_project_context",
    "Context for a project: recent sessions with their topics, and decisions and fixes extracted from them. Defaults to the current working directory.",
    {
      project: z.string().optional().describe("Project name or path. Defaults to current working directory."),
      depth: z.enum(["brief", "normal", "detailed"]).optional().describe("Detail level (default: normal)"),
    },
    async (args) => withDatabase((db) => handleGetProjectContext(db, args, cwd))
  );

  server.tool(
    "find_patterns",
    "Recurring patterns in what was asked: common topics, when work happens, repeated issues. Optionally for one project.",
    {
      project: z.string().optional().describe("Limit to a specific project"),
      type: z.enum(["topics", "workflows", "issues", "all"]).optional().describe("Type of patterns to find (default: all)"),
    },
    async (args) => withDatabase((db) => handleFindPatterns(db, args))
  );

  return { server, close };
}
