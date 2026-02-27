# ClaudeHistory MCP

> Give Claude Code a memory that persists between sessions.

**100% local by default. Your data never leaves your machine.**

## The Problem

Claude Code starts every session with amnesia. Fixed a gnarly bug last week? Claude has no idea. Made an architectural decision last month? Gone.

ClaudeHistory fixes this by indexing your existing conversation transcripts and making them searchable.

## Install (30 seconds)

Add to `~/.claude/settings.json`:

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

Restart Claude Code. Done.

## How It Works

```
~/.claude/projects/          ClaudeHistory MCP           Claude Code
┌─────────────────┐        ┌──────────────────┐        ┌──────────┐
│ Session JSONL    │───────▶│ Index + Search    │◀──────▶│ 7 Tools  │
│ files (already   │  read  │ BM25 + TF-IDF    │ query  │ available│
│ on your disk)    │  only  │ Knowledge Extract │        │ to Claude│
└─────────────────┘        └──────────────────┘        └──────────┘
                                    │
                           (optional, off by default)
                                    │
                                    ▼
                           ┌──────────────────┐
                           │ Cloud Sync Server │
                           │ (self-host or     │
                           │  hosted version)  │
                           └──────────────────┘
```

**Step 1:** Claude Code already saves every conversation as JSONL files in `~/.claude/projects/`. You have these right now.

**Step 2:** ClaudeHistory reads these files and builds a search index. Pure heuristics — BM25 ranking, TF-IDF scoring, Reciprocal Rank Fusion. No LLM calls. No API keys needed.

**Step 3:** Claude Code can now search your history using 7 MCP tools automatically.

**Step 4 (optional):** Enable cloud sync to share knowledge across devices or with your team. Only extracted patterns sync — never raw transcripts or source code.

## What Claude Can Do With It

| Tool | What It Does | Example |
|------|-------------|---------|
| `search_history` | Full-text search with filters | `"docker error project:myapp after:7d"` |
| `find_solutions` | Find past fixes for similar problems | `"ECONNREFUSED port conflict"` |
| `find_patterns` | Discover recurring issues across projects | Shows you keep hitting the same bugs |
| `get_session_summary` | Summarise any past session | Quick context on what happened |
| `list_projects` | See all projects with session counts | Overview of your work |
| `get_project_context` | Full context for a project | Recent decisions, solutions, patterns |
| `search_community_knowledge` | Search shared patterns (opt-in) | What other devs do for similar problems |

## Learnings System

The coolest part: ClaudeHistory automatically clusters similar solutions across your projects.

**Before:** You hit the same Docker port conflict 3 times across 2 projects, fixing from scratch each time.

**After:** Claude starts the session already knowing "Check port conflicts first when ECONNREFUSED — seen 3 times across 2 projects."

It uses Jaccard similarity on stemmed words, scored by frequency, cross-session spread, and cross-project reach. High-scoring clusters become "learnings" that surface automatically.

## Cloud Sync (Optional)

Everything is local by default. Zero network calls.

To sync knowledge across devices or share within your team, add a server:

```bash
# Self-host for free (AGPL)
git clone https://github.com/jhammant/claude-history-cloud
docker compose up -d
```

Then tell the MCP where to sync:

```bash
export CLAUDE_HISTORY_API_URL=http://localhost:3000
export CLAUDE_HISTORY_API_KEY=your-api-key
```

**What syncs:** Extracted patterns only — decisions, solutions, error→fix mappings.
**What never syncs:** Raw conversation transcripts, source code, file contents.

### Three Layers of Knowledge

| Layer | Priority | What | Privacy |
|-------|----------|------|---------|
| 🟢 Your Memory | 1.0× (highest) | Your own sessions | Always local |
| 🔵 Team Knowledge | 0.7× | Your team's shared patterns | E2E encrypted, opt-in |
| 🟣 Community Patterns | 0.4× | Anonymous patterns from other devs | Differential privacy, k-anonymity, opt-in |

Your own memory always ranks first. Team fills gaps. Community validates patterns.

## Privacy & Security

- **Local by default** — no network calls unless you configure cloud sync
- **No LLM calls** — pure heuristic search (BM25 + TF-IDF)
- **Source code never leaves your machine** — only structured patterns sync
- **Cloud sync is E2E encrypted**
- **Federation uses differential privacy** with k-anonymity (3+ contributors)
- **Full audit trail** at `~/.claude-history-mcp/audit/`

## Performance

- Indexes ~170 sessions in ~9 seconds
- Searches complete in <200ms
- 2 runtime dependencies
- Zero config required

## Links

- **MCP Client (this repo):** MIT license — use it however you want
- **Cloud Server:** [github.com/jhammant/claude-history-cloud](https://github.com/jhammant/claude-history-cloud) (AGPL)
- **npm:** `npm i claude-history-mcp`

## License

MIT
