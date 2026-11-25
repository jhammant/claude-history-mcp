# Codex history

Install and synchronize the `codex-sessions` companion from the claude-sessions
repository. This server indexes native Codex rollout files and the older private
normalized transcript feed alongside Claude history. Existing tool names and accepted
Claude data remain unchanged.

Native Codex rollout files (`~/.codex/sessions`, or `CLAUDE_HISTORY_CODEX_SESSIONS_DIR`) are
read directly; the feed described below is kept for compatibility.

The default feed is `~/.codex/transcript-feed/projects`, configurable through
`CODEX_HOME` or `CODEX_TRANSCRIPT_FEED`. Codex IDs are prefixed `codex-` so they
cannot collide with Claude session IDs. Codex sessions go into the same
`history.db` as Claude sessions, marked `source = codex`: search (filter with
`source:codex`), `read_session`, project listing/context and session summaries
all include the feed. The nightly `sweep` and the query-time top-up both read the
feed, incrementally by byte offset like any other transcript.

The feed writes tool calls and results into the message text as
`[external_agent_tool_call: <name>] … [/external_agent_tool_call]` and
`[external_agent_tool_result] … [/external_agent_tool_result]` blocks. These go into
the same tool fields as Claude's tool calls (so `tool:` filters work on Codex too).
Calls to this server's own tools (`mcp__claude-history__…`) keep their name, but their
input and their result (the block that follows) are not indexed.

Build with `npm run build`; servers pick up a new build when they restart. Run
`tests/indexing/indexer.test.ts`, `tests/indexing/own-tools.test.ts` and
`tests/e2e/server.test.ts` for hermetic indexing, search and tool checks of the feed.
The feed contains conversation text and tool calls and results, not reasoning. It is
local private data; do not commit or upload it.
