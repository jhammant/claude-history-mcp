# ClaudeHistory MCP

> Give Claude Code a memory that persists between sessions.

**100% local by default. Your data never leaves your machine.**

## The Problem

Claude Code starts every session with amnesia. Fixed a gnarly bug last week? Claude has no idea. Made an architectural decision last month? Gone.

ClaudeHistory fixes this by indexing your existing conversation transcripts and making them searchable.

## Install

1. Install version 2 from GitHub (Node 22 or newer):

```bash
npm install -g https://github.com/jhammant/claude-history-mcp/archive/refs/heads/main.tar.gz
```

2. Add the server to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "history": {
      "command": "claude-history-mcp"
    }
  }
}
```

3. Build the history database once (a few minutes for a large history):

```bash
claude-history-mcp sweep
```

4. Schedule the same command to run every night (cron, launchd or any scheduler), so the
   database keeps up with new sessions. Restart Claude Code. Done.

Until the database exists, every tool answers with the command to run instead of building
an index inside a tool call.

### Session-start context

After `npm run build`, register `node /absolute/path/to/claude-history-mcp/dist/hooks/session-start-hook.js`
as a `SessionStart` command in Claude Code's `~/.claude/settings.json` or Codex's
`~/.codex/hooks.json`. The hook returns recent project context as JSON using
`hookSpecificOutput.additionalContext`, which both clients accept. It emits nothing
when no context is available (or the database is missing or busy). Context starting
with `[ClaudeHistory]` stays inside the JSON string so Codex does not mistake the prefix
for a JSON array. It reads two small indexed tables and takes a few tens of milliseconds.

## How It Works

```text
~/.claude/projects/**.jsonl           ──┐  sweep (nightly)         ┌───────────────────────────┐
  sessions + subagent runs              │                          │ ~/.claude-history-mcp/    │
~/.codex/transcript-feed/projects/    ──┤  top-up (at query time,─▶│   history.db  (SQLite)    │
~/.codex/sessions/**/rollout-*.jsonl  ──┤  ≤300 ms, newest first)  │   messages + FTS5 index   │
~/.pi/agent/sessions/**.jsonl         ──┘                          │   sessions, summaries,    │
                                                                   │   knowledge               │
                                                                   └─────────────▲─────────────┘
                                                                                │ read
                                                      one MCP server per Claude Code / Codex / pi session
```

**Transcripts.** Claude Code saves every conversation as JSONL under `~/.claude/projects/`
(subagent runs under `<session>/subagents/`). Native Codex rollout files are read
directly from `~/.codex/sessions/` and pi session files from `~/.pi/agent/sessions/`;
the older Codex feed (`~/.codex/transcript-feed/projects/`) is still read if present.
Codex and pi sessions get their project from the working directory they recorded, and
sit in the same database as `source = codex` and `source = pi`. If a Codex session exists as
both a feed file and a rollout (the same `codex-<id>`), the file indexed first feeds it and the
other is skipped, so its messages are stored once.
A forked Codex session (a subagent, or a resumed copy) starts by replaying its parent's
history; the replay is skipped, so only the fork's own messages are indexed under it.

**One database.** `history.db` holds one row per message: the prose, the tool names, and
the tool activity (commands, file paths, search patterns, and tool results capped at about
2,000 characters each, binary data dropped). Thinking blocks and `<system-reminder>`
blocks are left out. Calls to this server's own tools keep their name, but neither their
input nor their result is indexed, so a past search for X never becomes a hit for X.
An SQLite FTS5 index (porter stemming) covers prose and tool activity. Subagent runs are
their own sessions, with ids like `agent-<id>@<parent session id>`.

**Incremental.** Transcripts are append-only, so the sweep reads only the bytes added since
the last run, up to the last complete line. A file that shrank or was replaced is read
again from the start. Two indexers working on one file at once cannot insert anything
twice: each batch re-checks the stored offset inside its write transaction.

**Each Claude line once.** Claude Code copies a session's history into the file of a session
it forks, and one session file can sit under two spellings of a project path. Each user and
assistant line has a `uuid`; the database remembers the ones it has indexed and skips a line
it already holds. A forked session therefore keeps only its own lines: the shared history is
found under the session that had it first (the sweep reads the oldest files first, so a sweep
and a rebuild agree). Its first prompt and times are its own, and its working directory and
branch come from the copied lines only when its own lines do not say. The sweep output counts
the lines it skipped. Upgrading from version 2 in place keeps what is indexed, and does not
remove duplicates already in the database; run `rebuild` once to do that (sessions whose transcripts are gone are kept as they are).

**Nothing runs in the background.** There is no daemon, watcher or timer. Freshness comes
from the scheduled sweep, plus a short top-up a server may do before a search (transcripts
changed since the last sweep, newest first, within about 300 ms, at most every 20 seconds).
When it cannot catch up, the search result says so in one line.

**Thin servers.** A server opens the database on its first tool call and runs SQL; it keeps
no index in memory, so each copy uses tens of MB rather than GBs.

**History outlives transcripts.** Claude Code deletes transcripts after about 30 days.
The database never drops a session because its file has gone, so it becomes the long-term
archive; `read_session` opens those sessions too.

### Hosts and repositories

Every session records the host it came from and the repository it belongs to, so one
database can hold several machines and `list_projects` can show one project once.

- **Host.** A label on each session, set once by the first machine to deliver it. It is
  `CLAUDE_HISTORY_HOST`, else the machine's hostname up to its first dot. Because it also
  names this machine's map file, it is cleaned: characters outside `[A-Za-z0-9._-]` become
  `_`, a leading `.` or `-` becomes `_`, and it is cut to 64 characters. Search it with
  `host:laptop`; `host:unknown` finds sessions indexed before hosts were recorded.
- **Repository.** The sweep works it out from the first of these that applies:
  1. the git remote the session itself recorded, when the session saw git (a branch or a
     remote) in its own working directory. Only Codex sessions record a remote (the one in
     the session header); Claude Code and pi sessions record none;
  2. the repository map, a file per machine with one line per directory: the directory,
     its main repository root and its `origin` URL. The row for the session's directory
     applies, or else the row for the nearest parent directory that has one; it gives both
     the key and the root, and a row with no usable remote gives a key by host and path;
  3. the session's own remote when it was recorded for another directory (a Codex session
     whose first activity was outside the directory its header names), with no map row for
     the session's directory;
  4. the remote of another session on the same host that ran in exactly the same directory
     and saw git there;
  5. worktree folding: `<repo>/.claude/worktrees/<name>` belongs to `<repo>`, and so does
     `<repo>/.worktrees/<name>` (also `worktrees`; see `CLAUDE_HISTORY_WORKTREE_DIRS`) when
     `<repo>` is known to be a git work tree;
  6. the working directory itself.

  A repository with a remote is keyed `host/owner/name` (for example `example.com/acme/app`)
  and is one repository on every machine. One without a remote is keyed by host and path, so
  the same path on `laptop` and `desktop` is not taken to be one repository unless a git
  remote says so.
  A project filter reaches every directory of the repositories it matches, except that a
  session inside another matched repository's tree (a worktree of one repository under the
  other's folder) does not bring in the rest of its own repository.
- **What runs.** `sweep` asks git about the working directories of the sessions it indexed
  and appends the answers to `<host>.jsonl` in the map directory (`CLAUDE_HISTORY_REPO_MAP_DIR`,
  default `<data dir>/repo-map`). When the resolution settings change
  (`CLAUDE_HISTORY_REPO_HOST_ALIASES` or `CLAUDE_HISTORY_WORKTREE_DIRS`), and on the first
  sweep after the upgrade, it asks about every directory of this host's sessions instead.
  The git commands are `rev-parse --show-toplevel`, `rev-parse --show-prefix`,
  `rev-parse --path-format=absolute --git-common-dir`, `rev-parse --is-bare-repository`,
  `config --get core.worktree` and `remote get-url origin`: all local and read-only, each
  with a 5 second timeout and with prompts and optional locks turned off. It makes no
  network call; with git missing or outside a repository it records nothing. The query-time
  top-up never runs git. The map file holds directory paths and remote URLs with any
  credentials removed. `record-repo` (see Commands) writes the same file.
- **Map files.** Each sweep reads only this host's own file, `<host>.jsonl` in the map
  directory. Other files there (another machine's, in a shared or synced folder) are
  ignored, so one machine's entries never apply to another. Malformed lines, relative paths
  and `..` paths are ignored, and a newer entry (by its `at` time) replaces an older one for
  the same directory.

Upgrading: the database migrates in place to schema version 4 on the next `sweep`. A session
indexed earlier shows host `unknown` until it is next indexed, and until then it is keyed by
its path alone, with no host or remote; `claude-history-mcp rebuild` re-indexes every session
whose transcript still exists. Sessions whose transcript is gone keep host `unknown`.

## Commands

```bash
node dist/index.js                       # the MCP server (stdio); what Claude Code runs
node dist/index.js sweep [--json]        # index what changed, refresh summaries; alias: index
node dist/index.js status [--json]       # size, sessions, messages, oldest/newest, files behind, last sweep
node dist/index.js search "<query>" [--limit N] [--project P] [--context] [--sort recent] [--timing] [--no-topup]
node dist/index.js rebuild [--json]      # build a fresh database beside the old one and swap it in
node dist/index.js import-legacy         # one-time import from the version 1 index (see below)
node dist/index.js record-repo [dir]     # note which repository a directory belongs to (default: the current directory); prints nothing
npm run build-index                      # same as sweep, from the TypeScript sources
```

`sweep` prints one line of totals and exits 0 on success (non-zero on failure). It is safe
to run while servers are reading, and a second sweep started while one is running exits
cleanly. It also applies schema upgrades after an update (servers never migrate inside a
tool call: on an outdated database they answer with the command to run). It compacts the
file (`VACUUM`, about 10 s for a large history) after a migration, or once a tenth of the
messages are new since the last compaction: keeping each table in one place roughly halves
the time of a search on a cold disk cache. `rebuild` keeps every session whose transcript no longer exists, and swaps the
new database in with SQLite's online backup, so open servers simply see the new data.

`record-repo` asks local git about one directory and appends the answer to this machine's
map file. It prints nothing and always exits 0, so it is safe in a `SessionStart` hook:

```json
{"type": "command", "command": "claude-history-mcp record-repo"}
```

It helps when a worktree is deleted before the next sweep, which could no longer ask git
about it.

### Upgrading from version 1 (index.msgpack)

Version 1 (0.x) kept an in-memory index in `~/.claude-history-mcp/index.msgpack`, which
may be the only copy of sessions whose transcripts Claude Code has since deleted. Import
it once, after the first sweep and not alongside another heavy job:

```bash
node dist/index.js import-legacy
```

It imports the old index's sessions that have no transcript on disk (as archived chunks),
every file in `summaries/`, and `knowledge.json`. Running it again changes nothing. The
old index unpacks to several GB, so the command re-launches itself with a larger heap.
The old files are left in place; delete them yourself once you are happy.

### Environment variables

| Variable | Default | What it sets |
|----------|---------|--------------|
| `CLAUDE_HISTORY_DATA_DIR` | `~/.claude-history-mcp` | Where `history.db` lives |
| `CLAUDE_HISTORY_CLAUDE_DIR` | `~/.claude` | Claude Code's config dir (settings, commands) |
| `CLAUDE_HISTORY_PROJECTS_DIR` | `<claude dir>/projects` | Claude Code transcripts |
| `CODEX_TRANSCRIPT_FEED` | `<CODEX_HOME>/transcript-feed` | Codex feed root (reads its `projects/`) |
| `CLAUDE_HISTORY_CODEX_SESSIONS_DIR` | `<CODEX_HOME or ~/.codex>/sessions` | Native Codex rollout files |
| `CLAUDE_HISTORY_PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | Native pi session files |
| `CODEX_HOME` | `~/.codex` | Codex home |
| `CLAUDE_HISTORY_TOPUP_MS` | `300` | Query-time indexing budget in ms; `0` turns it off |
| `CLAUDE_HISTORY_HOST` | hostname up to its first dot | Name of this machine, recorded on each session it indexes first and naming its map file; cleaned as described under Hosts and repositories |
| `CLAUDE_HISTORY_REPO_MAP_DIR` | `<data dir>/repo-map` | Directory of per-machine repository maps (`<host>.jsonl`); a sweep reads only its own host's file |
| `CLAUDE_HISTORY_REPO_HOST_ALIASES` | none | Git host aliases, `a=b,c=d`: remotes on host `a` count as host `b` (for example `git.internal=example.com`) |
| `CLAUDE_HISTORY_WORKTREE_DIRS` | `.worktrees,worktrees` | Comma-separated folder names that hold a repository's worktrees; set but empty means none |

## What Claude Can Do With It

| Tool | What It Does | Example |
|------|-------------|---------|
| `search_history` | Full-text search, grouped by session, with snippets around the matched words | `"docker error project:myapp after:7d"` |
| `read_session` | Page through one session's messages, even after its transcript is deleted | `session_id, around: 57` |
| `find_solutions` | Find past fixes for similar problems | `"ECONNREFUSED port conflict"` |
| `find_patterns` | Discover recurring issues across projects | Shows you keep hitting the same bugs |
| `get_session_summary` | Summarise any past session | Quick context on what happened |
| `list_projects` | List projects with session counts, newest first (30 by default; `limit` and `query` narrow it) | Overview of your work |
| `get_project_context` | Context for a project | Recent sessions, decisions, fixes |

### Search syntax

- All words must match; when that finds too few sessions, partial matches fill the rest
  (marked "partial match"), ranked by how much of the query they contain.
- `"exact phrase"`, `redis OR memcached`.
- Identifiers work as typed: `index.msgpack`, `ERR_SQLITE_ERROR`, `src/server.ts`.
- Filters: `project:` `branch:` `tool:Bash` `role:user|assistant|tool` `source:claude|codex|pi`
  `host:laptop` (`host:unknown` for sessions indexed before hosts were recorded) `session:<id>` `after:7d` `before:2026-01-15` (relative `h/d/w/m/y`, ISO dates, `today`).
  `session:` takes a session id or prefix: a parent session's id also covers its subagents,
  and `session:agent-<id>` finds that subagent under every parent.
- Each hit is labelled with its working directory (home shown as `~`), the date, the
  session id and the message number.
- `sort: "recent"` orders by date instead of relevance; `include_context: true` adds the
  messages either side of each hit.

Ranking is FTS5 `bm25()` with prose weighted above tool input, above tool output, a mild
recency boost, a boost for the project you are in, and a small penalty for subagent runs.
Filters are applied before ranking and limiting; filters on sessions (project, branch,
source, session, dates) and on role run inside the full-text query itself when they narrow
the search to about a hundred sessions or fewer.

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
- **No LLM calls** — SQLite full-text search (FTS5, bm25 ranking)
- **Source code never leaves your machine** — only structured patterns sync
- **Cloud sync is E2E encrypted**
- **Federation uses differential privacy** with k-anonymity (3+ contributors)
- **Full audit trail** at `~/.claude-history-mcp/audit/`

## Performance

Measured on one developer's history (about 6,000 transcripts, 9 GB of JSONL, 225,000
messages) on an Apple-silicon Mac under load:

| What | Result |
|------|--------|
| First full build | about 3 minutes, peak memory 350 MB, database 730 MB |
| Nightly sweep, nothing changed | 0.3 s |
| Sweep after a line is appended to a 215 MB transcript | 0.1 s |
| Search, warm (p50 / p95) | 6 ms / 39 ms |
| Search, new process incl. Node start-up (p50 / p95) | 130 ms / 170 ms |
| Server memory after ten searches | about 120 MB |
| Session-start hook | about 70–85 ms, Node start-up included |

Two runtime dependencies besides the MCP SDK: `better-sqlite3` (pinned) and `zod`.
`msgpackr` is only loaded by `import-legacy`.

## Links

- **MCP Client (this repo):** MIT license — use it however you want
- **Cloud Server:** [github.com/jhammant/claude-history-cloud](https://github.com/jhammant/claude-history-cloud) (AGPL)
- **npm:** `claude-history-mcp` (still version 1; install version 2 from GitHub as above)

## License

MIT
