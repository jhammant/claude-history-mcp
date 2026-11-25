/**
 * Schema v4: where a session came from and which repository it belongs to.
 *
 * sessions.host is the machine the session was indexed from ('' = unknown: indexed before
 * schema 4, shown as "unknown"). git_remote, repo, repo_root and cwd_git carry the session's
 * repository identity; repo_map holds directory-to-repository lines recorded per machine.
 */

export const SCHEMA_V4_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ["sessions", "host", "TEXT NOT NULL DEFAULT ''"], // machine the session came from; '' = unknown
  ["sessions", "git_remote", "TEXT"], // origin URL the session itself recorded, credentials stripped
  ["sessions", "repo", "TEXT"], // resolved repository key: host/owner/name, or [<host>:]<path>
  ["sessions", "repo_root", "TEXT"], // main repository root
  ["sessions", "cwd_git", "INTEGER NOT NULL DEFAULT 0"], // 1: a line at the session's own cwd carried a real git branch (not HEAD) or a remote
];

export const SCHEMA_V4 = `
CREATE INDEX IF NOT EXISTS sessions_repo ON sessions(repo, end_time);
CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS sessions_host ON sessions(host);

CREATE TABLE IF NOT EXISTS repo_map (
  host   TEXT NOT NULL,      -- the machine the directory is on
  dir    TEXT NOT NULL,      -- absolute work-tree root
  root   TEXT NOT NULL,      -- its main repository root
  remote TEXT,               -- origin URL, credentials stripped
  at     INTEGER NOT NULL,   -- unix seconds it was recorded; a newer line replaces an older one
  PRIMARY KEY (host, dir)
);
`;
