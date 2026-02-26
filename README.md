# Claude History MCP

An MCP server that makes your Claude Code conversation history searchable and proactively useful. Indexes all past sessions with hybrid BM25 + TF-IDF search, extracts knowledge (decisions, solutions, error fixes), and auto-injects project context at session start.

## What it does

Claude Code stores full conversation transcripts as JSONL files in `~/.claude/projects/`. This MCP server indexes them and provides 6 tools:

| Tool | Purpose |
|------|---------|
| `search_history` | Full-text search across all conversations with filter syntax |
| `find_solutions` | Find how you fixed errors/problems before |
| `get_session_summary` | Structured summary of any session |
| `list_projects` | List all projects with session counts and dates |
| `find_patterns` | Discover recurring topics, workflows, and issues |
| `get_project_context` | Full project context (recent sessions, decisions, knowledge) |

### Key features

- **Hybrid search**: BM25 (keyword precision) + TF-IDF (semantic recall) fused with Reciprocal Rank Fusion
- **Filter syntax**: `project:name`, `before:7d`, `after:2024-01-15`, `tool:Bash`
- **Knowledge extraction**: Automatically extracts decisions, solutions, and error→fix patterns from conversations
- **Proactive context**: Session-start hook injects relevant project history into new sessions
- **Incremental indexing**: File watcher detects new/changed sessions and re-indexes automatically
- **Fast**: Index build ~9s for 170 sessions, searches <200ms

## How it works

```text
┌──────────────────────────────────────────────────────┐
│                  ClaudeHistoryMCP                     │
├──────────────┬───────────────┬───────────────────────┤
│  MCP Server  │  /claude-history  │  SessionStart Hook │
│  (6 tools)   │  Skill            │  (auto-context)    │
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

### Search engine

1. **Tokenizer**: lowercase → strip markdown → split → remove stop words → Porter stem → bigrams
2. **BM25**: Inverted index for keyword precision (Okapi BM25, k1=1.2, b=0.75)
3. **TF-IDF**: Sparse vectors + cosine similarity for semantic recall
4. **Fusion**: Reciprocal Rank Fusion (RRF) combining both rankings
5. **Boosting**: recency (7d=1.2x, 30d=1.1x) + project-match (1.3x if cwd matches)

### Knowledge extraction

When sessions end (file stops changing for 5+ minutes), the system automatically extracts:

- **Decisions**: "decided to", "going with", "chose" patterns
- **Solutions**: "fixed", "solved", "the issue was" patterns
- **Error fixes**: error → resolution sequences

### Data storage

Runtime data stored at `~/.claude-history-mcp/`:

```text
~/.claude-history-mcp/
  index.msgpack               # Serialized search index
  knowledge.json              # Extracted knowledge entries
  summaries/{sessionId}.json  # Cached session summaries
  meta.json                   # Last-indexed timestamps
```

## Installation

```bash
git clone https://github.com/jhammant/ClaudeHistoryMCP.git
cd ClaudeHistoryMCP
npm install
npm run build
```

### 1. Build the search index

```bash
npm run build-index
```

This parses all your Claude Code conversation history and builds the search index. Takes ~10 seconds for ~170 sessions.

### 2. Register the MCP server

```bash
claude mcp add claude-history -- node "/path/to/ClaudeHistoryMCP/dist/index.js"
```

### 3. Install the session-start hook and skill (optional)

```bash
npm run install-hook
```

This registers a `SessionStart` hook in `~/.claude/settings.json` that auto-injects project context, and installs the `/claude-history` skill.

## Usage

### Via MCP tools (automatic)

Once registered, Claude Code can use the tools directly:

```text
User: "Have I dealt with this ECONNREFUSED error before?"
Claude: [calls find_solutions with "ECONNREFUSED"]
→ Shows past solutions from your history
```

### Via the /claude-history skill

```bash
/claude-history docker network error          # General search
/claude-history --solutions ECONNREFUSED      # Find past error fixes
/claude-history --summary                     # Summarize last session
/claude-history --patterns                    # Discover recurring patterns
/claude-history --context                     # Get full project context
/claude-history --projects                    # List all projects
```

### Filter syntax

Queries support inline filters:

```text
search_history("docker error project:ghostty after:7d")
search_history("authentication tool:Bash before:2024-06-01")
search_history("deployment project:myapp after:30d")
```

- `project:name` — filter to a project (partial match)
- `before:date` / `after:date` — date filter (ISO or relative: `7d`, `1w`, `1m`, `1y`)
- `tool:name` — filter to sessions using a specific tool

### Session-start hook

When you start a new Claude Code session, the hook automatically outputs:

```text
[ClaudeHistory] Previous context for myproject:
- Last session (2 days ago): Fixed Docker networking — switched to host networking
- Key decision: Use systemd timer instead of cron for scheduling
- Solution found: CORS issue resolved by adding proxy config
```

## Project structure

```text
src/
  index.ts                    # MCP server entry (stdio transport)
  server.ts                   # Tool registration via McpServer + zod
  config.ts                   # Paths, constants, defaults
  parsers/
    history-parser.ts         # Parse ~/.claude/history.jsonl
    session-parser.ts         # Stream-parse session JSONL files
    content-extractor.ts      # Extract text from message content arrays
  indexing/
    index-manager.ts          # Orchestrate indexing, persistence, incremental updates
    bm25.ts                   # BM25 inverted index (Okapi BM25)
    tfidf.ts                  # TF-IDF vectors + cosine similarity
    tokenizer.ts              # Tokenize, stem, stop words, bigrams
    document-store.ts         # Store indexed document chunks + metadata
  search/
    search-engine.ts          # Hybrid search: BM25 + TF-IDF + RRF fusion
    query-processor.ts        # Parse query syntax (project:, before:, after:)
    result-ranker.ts          # Score fusion, recency/project boost, dedup
  knowledge/
    knowledge-store.ts        # Persist extracted knowledge entries
    session-summarizer.ts     # Generate session summaries (heuristic, no LLM)
    knowledge-extractor.ts    # Extract decisions, solutions, error fixes
  watcher/
    file-watcher.ts           # Debounced fs.watch on conversation files
    incremental-indexer.ts    # Diff mtimes, re-index only changed files
  tools/                      # One file per MCP tool handler
  hooks/
    session-start-hook.ts     # Auto-inject project context on session start
  utils/
    stemmer.ts                # Inline Porter stemmer (no deps)
    path-encoder.ts           # Encode/decode Claude's project path format
    cache.ts                  # LRU cache
  cli/
    build-index.ts            # Build the full search index
    install.ts                # Install hook + skill
commands/
  claude-history.md           # /claude-history skill definition
tests/                        # Unit + integration tests (44 tests)
```

## Dependencies

Minimal — only 2 runtime dependencies:

- `@modelcontextprotocol/sdk` — MCP protocol
- `msgpackr` — efficient index serialization
- `zod` — schema validation (peer dep of MCP SDK)

Porter stemmer and stop words are implemented inline.

## Development

```bash
npm run dev          # Run with tsx (no build needed)
npm run build        # Compile TypeScript
npm test             # Run tests
npm run test:watch   # Watch mode
npm run build-index  # Rebuild the search index
```

## Cloud Sync

Optionally sync your knowledge entries and session summaries to a cloud backend for team sharing and cross-machine access.

### Setup

Set environment variables:

```bash
export CLAUDE_HISTORY_CLOUD_URL=https://your-cloud-instance.example.com
export CLAUDE_HISTORY_CLOUD_API_KEY=your-64-char-api-key
export CLAUDE_HISTORY_CLOUD_TEAM_ID=your-team-uuid  # optional, for team sharing
```

### How it works

The sync client (`src/sync/sync-client.ts`) provides:
- **Push**: Upload local knowledge entries and session summaries to the cloud
- **Pull**: Download team-shared knowledge to enrich local search
- **Full sync**: Bidirectional push + pull in one call

The cloud backend ([claude-history-cloud](https://github.com/jhammant/claude-history-cloud)) handles multi-user auth, team management, and server-side search.

## Federated Learning

Share anonymised patterns with the community without exposing private data.

See [README-FEDERATION.md](./README-FEDERATION.md) for full details.

### Key features

- **Privacy-first**: All patterns are stripped of identifiers, generalised, and hashed before sharing
- **K-anonymity**: Patterns only become visible when ≥3 independent contributors submit them
- **Community search**: `search_community` MCP tool queries the shared pattern database
- **Opt-in**: Federation is disabled by default

### Quick start

```bash
# Configure federation
export FEDERATION_API_URL=https://your-cloud-instance.example.com/api/federation

# Use the CLI
npm run federation -- contribute
npm run federation -- search "docker networking"
npm run federation -- stats
```

## License

MIT
