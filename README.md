# ClaudeHistory MCP

> Give Claude Code a memory. Search your conversation history, find past solutions, and let your team learn together.

**100% local by default. Your data never leaves your machine.**

## Quick Start (30 seconds)

Add to your Claude Code config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "history": {
      "command": "npx",
      "args": ["-y", "claude-history-mcp"]
    }
  }
}
```

Restart Claude Code. Done. Your past sessions are now searchable.

## What It Does

Claude Code stores full conversation transcripts as JSONL files in `~/.claude/projects/`. This MCP server indexes them and provides 7 tools:

| Tool | Purpose |
|------|---------|
| `search_history` | Full-text search across all conversations with filter syntax |
| `find_solutions` | Find how you fixed errors/problems before |
| `get_session_summary` | Structured summary of any session |
| `list_projects` | List all projects with session counts and dates |
| `find_patterns` | Discover recurring topics, workflows, and issues |
| `get_project_context` | Full project context (recent sessions, decisions, knowledge) |
| `search_community_knowledge` | Search community-shared patterns via federated learning |

## Features

### 🔍 Hybrid Search
BM25 + TF-IDF with Reciprocal Rank Fusion. Filter by project, date, tool usage.

### 🧠 Knowledge Extraction
Automatically extracts decisions, solutions, and error→fix patterns from your sessions.

### ⚡ Proactive Context
Session-start hook injects relevant project history into new sessions automatically.

### ☁️ Cloud Sync (Optional)
Sync knowledge across devices. Share learnings within your team. Self-host or use our hosted version.

### 🌐 Federated Learning (Optional)
Opt-in anonymous pattern sharing. Your Claude learns from the community without exposing your code.

## Cloud Sync

By default, everything stays local. To enable cloud sync:

```bash
# Self-host (free)
git clone https://github.com/jhammant/claude-history-cloud
cd claude-history-cloud
docker compose up -d

# Or use our hosted version
# Sign up at claudehistory.com (coming soon)
```

Then set environment variables:

```bash
export CLAUDE_HISTORY_API_URL=http://localhost:3000  # or https://api.claudehistory.com
export CLAUDE_HISTORY_API_KEY=your-api-key
export CLAUDE_HISTORY_TEAM_ID=optional-team-id
```

## Federation

Opt-in anonymous knowledge sharing:

```bash
claude-history-mcp federation enable
claude-history-mcp federation status
```

See [README-FEDERATION.md](./README-FEDERATION.md) for full details.

## Privacy & Security

- **Local by default** — no network calls unless you configure cloud sync
- **Cloud sync is E2E encrypted** — server cannot read team data
- **Federation uses differential privacy** — patterns are anonymous, k-anonymity enforced
- **Source code never leaves your machine** — only extracted patterns (decisions, solutions) sync
- **Full audit trail** — see exactly what was shared in `~/.claude-history-mcp/audit/`

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│                  ClaudeHistoryMCP                     │
├──────────────┬───────────────┬───────────────────────┤
│  MCP Server  │  /claude-history  │  SessionStart Hook │
│  (7 tools)   │  Skill            │  (auto-context)    │
├──────────────┴───────────────┴───────────────────────┤
│              Hybrid Search Engine                     │
│          BM25 (keywords) + TF-IDF (semantic)         │
├──────────────────────────────────────────────────────┤
│  Indexing Pipeline  │  Knowledge Layer  │  Summaries  │
├──────────────────────────────────────────────────────┤
│  JSONL Parsers  │  File Watcher  │  Document Store    │
└──────────────────────────────────────────────────────┘
         ↕                    ↕
~/.claude/history.jsonl    ~/.claude/projects/*/*.jsonl
```

## Self-Hosting the Server

See [claude-history-cloud](https://github.com/jhammant/claude-history-cloud) for the full server.

```bash
docker compose up -d  # PostgreSQL + API server
```

## License

MIT — use it however you want.
