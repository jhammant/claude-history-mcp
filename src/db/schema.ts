/**
 * Schema and migrations. The schema version lives in PRAGMA user_version; each
 * migration runs in its own transaction, in order, exactly once.
 */

import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const SCHEMA_V1 = `
CREATE TABLE sessions (
  sid            INTEGER PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,      -- file name stem: <uuid>, codex-<id> or agent-<id>
  project        TEXT NOT NULL,             -- encoded project dir, e.g. -work-app
  cwd            TEXT,
  git_branch     TEXT,
  source         TEXT NOT NULL,             -- 'claude' | 'codex'
  is_subagent    INTEGER NOT NULL DEFAULT 0,
  parent_session TEXT,                      -- parent session id for subagents
  title          TEXT,                      -- custom/AI title, or the subagent's description
  first_prompt   TEXT,
  start_time     INTEGER,                   -- ms since epoch
  end_time       INTEGER,
  message_count  INTEGER NOT NULL DEFAULT 0,
  legacy         INTEGER NOT NULL DEFAULT 0 -- 1: imported from the pre-SQLite index
);
CREATE INDEX sessions_project_end ON sessions(project, end_time);
CREATE INDEX sessions_end ON sessions(end_time);
CREATE INDEX sessions_parent ON sessions(parent_session);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  session_sid INTEGER NOT NULL REFERENCES sessions(sid),
  seq         INTEGER NOT NULL,             -- 0-based position within the session
  role        TEXT NOT NULL,                -- 'user' | 'assistant' | 'tool' (legacy rows: also 'mixed')
  ts          INTEGER,                      -- ms since epoch
  tools       TEXT NOT NULL DEFAULT '',     -- tool names, space separated
  prose       TEXT NOT NULL DEFAULT '',
  tool_input  TEXT NOT NULL DEFAULT '',     -- commands, paths, patterns, queries
  tool_output TEXT NOT NULL DEFAULT ''      -- tool results, capped per result
);
CREATE UNIQUE INDEX messages_session_seq ON messages(session_sid, seq);
CREATE INDEX messages_ts ON messages(ts);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  prose, tool_input, tool_output,
  content='messages', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, prose, tool_input, tool_output)
  VALUES (new.id, new.prose, new.tool_input, new.tool_output);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, prose, tool_input, tool_output)
  VALUES ('delete', old.id, old.prose, old.tool_input, old.tool_output);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF prose, tool_input, tool_output ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, prose, tool_input, tool_output)
  VALUES ('delete', old.id, old.prose, old.tool_input, old.tool_output);
  INSERT INTO messages_fts(rowid, prose, tool_input, tool_output)
  VALUES (new.id, new.prose, new.tool_input, new.tool_output);
END;

CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  session_sid INTEGER NOT NULL REFERENCES sessions(sid),
  size        INTEGER NOT NULL,             -- size when last checked
  mtime       INTEGER NOT NULL,             -- mtime (ms) when last checked
  ino         INTEGER NOT NULL,
  head        TEXT NOT NULL DEFAULT '',     -- hash of the first bytes, to spot a replaced file
  offset      INTEGER NOT NULL DEFAULT 0,   -- bytes indexed: always the end of a complete line
  tail_rowid  INTEGER,                      -- last message row, which later lines may extend
  tail_msg_id TEXT,                         -- API message id of that row (assistant turns)
  indexed_at  INTEGER
);
CREATE INDEX files_session ON files(session_sid);

CREATE TABLE summaries (
  session_id TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  end_time   INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL                  -- SessionSummary as JSON
);
CREATE INDEX summaries_project_end ON summaries(project, end_time);

CREATE TABLE knowledge (
  id            INTEGER PRIMARY KEY,
  type          TEXT NOT NULL,              -- decision | solution | error_fix | pattern
  project       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  ts            INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL,
  details       TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]', -- JSON array
  related_files TEXT NOT NULL DEFAULT '[]', -- JSON array
  UNIQUE (project, type, summary)
);
CREATE INDEX knowledge_project_type_ts ON knowledge(project, type, ts);
CREATE INDEX knowledge_session ON knowledge(session_id);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE locks (
  name     TEXT PRIMARY KEY,
  pid      INTEGER NOT NULL,
  acquired INTEGER NOT NULL
);
`;

/**
 * v2: text moves out of `messages` into `message_text`, so the rows a search joins on
 * (session, role, time, tools) are small and a filtered search reads few pages. The
 * FTS index gains a `scope` column ("s<session sid> r<role>", weight 0) so session and
 * role filters can run inside the MATCH instead of after it. Files remember tool calls
 * still waiting for their results, and subagent ids include their parent session.
 */
const SCHEMA_V2 = `
CREATE TABLE message_text (
  id          INTEGER PRIMARY KEY,          -- = messages.id
  prose       TEXT NOT NULL DEFAULT '',
  tool_input  TEXT NOT NULL DEFAULT '',
  tool_output TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT ''      -- 's<session sid> r<role>', for filtering inside FTS
);
INSERT INTO message_text(id, prose, tool_input, tool_output, scope)
  SELECT id, prose, tool_input, tool_output, 's' || session_sid || ' r' || role FROM messages;

DROP TRIGGER messages_ai;
DROP TRIGGER messages_ad;
DROP TRIGGER messages_au;
DROP TABLE messages_fts;

CREATE TABLE messages_v2 (
  id          INTEGER PRIMARY KEY,
  session_sid INTEGER NOT NULL REFERENCES sessions(sid),
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  ts          INTEGER,
  tools       TEXT NOT NULL DEFAULT ''
);
INSERT INTO messages_v2(id, session_sid, seq, role, ts, tools)
  SELECT id, session_sid, seq, role, ts, tools FROM messages;
DROP TABLE messages;
ALTER TABLE messages_v2 RENAME TO messages;
CREATE UNIQUE INDEX messages_session_seq ON messages(session_sid, seq);
CREATE INDEX messages_ts ON messages(ts);
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_text WHERE id = old.id;
END;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  prose, tool_input, tool_output, scope,
  content='message_text', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
CREATE TRIGGER message_text_ai AFTER INSERT ON message_text BEGIN
  INSERT INTO messages_fts(rowid, prose, tool_input, tool_output, scope)
  VALUES (new.id, new.prose, new.tool_input, new.tool_output, new.scope);
END;
CREATE TRIGGER message_text_ad AFTER DELETE ON message_text BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, prose, tool_input, tool_output, scope)
  VALUES ('delete', old.id, old.prose, old.tool_input, old.tool_output, old.scope);
END;
CREATE TRIGGER message_text_au AFTER UPDATE ON message_text BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, prose, tool_input, tool_output, scope)
  VALUES ('delete', old.id, old.prose, old.tool_input, old.tool_output, old.scope);
  INSERT INTO messages_fts(rowid, prose, tool_input, tool_output, scope)
  VALUES (new.id, new.prose, new.tool_input, new.tool_output, new.scope);
END;

ALTER TABLE files ADD COLUMN pending_tools TEXT NOT NULL DEFAULT '';

UPDATE sessions SET id = id || '@' || parent_session
  WHERE is_subagent = 1 AND parent_session IS NOT NULL AND instr(id, '@') = 0;
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "sessions, messages with FTS5, files, summaries, knowledge",
    up: (db) => db.exec(SCHEMA_V1),
  },
  {
    version: 2,
    description: "slim messages + message_text, FTS scope column, pending tool calls, subagent ids per parent",
    up: (db) => db.exec(SCHEMA_V2),
  },
];

/** The FTS `scope` value of a message: its session and role as two tokens. */
export function scopeOf(sessionSid: number, role: string): string {
  return `s${sessionSid} r${role}`;
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export class SchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `history.db has schema version ${found}, but this build only knows up to ${supported}. ` +
        "Update claude-history-mcp."
    );
    this.name = "SchemaTooNewError";
  }
}

/** Apply every migration newer than the database's version. Returns the versions applied. */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > latest) throw new SchemaTooNewError(current, latest);

  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    // IMMEDIATE: two processes creating the database at once must not both run v1.
    db.transaction(() => {
      const now = db.pragma("user_version", { simple: true }) as number;
      if (now >= migration.version) return;
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
      applied.push(migration.version);
    }).immediate();
  }
  return applied;
}
