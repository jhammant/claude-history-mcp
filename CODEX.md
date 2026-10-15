# Codex history

Install and synchronize the `codex-sessions` companion from the claude-sessions
repository. This server indexes its private normalized transcript feed alongside
Claude history. Existing tool names and accepted Claude data remain unchanged.

The default feed is `~/.codex/transcript-feed/projects`, configurable through
`CODEX_HOME` or `CODEX_TRANSCRIPT_FEED`. Codex IDs are prefixed `codex-` so they
cannot collide with Claude session IDs. Search, project listing/context and
session summaries all include the feed. The watcher observes both roots and
no longer drops a final update merely because the file was recently written.

Build with `npm run build` and restart the MCP process after installing changes.
Run `tests/integration/codex-feed.test.ts` for hermetic search, summary and live
update checks. The feed contains conversation text, not tool output or reasoning.
It is local private data; do not commit or upload it.
