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
export {};
//# sourceMappingURL=session-start-hook.d.ts.map