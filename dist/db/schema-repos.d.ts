/**
 * Schema v4: where a session came from and which repository it belongs to.
 *
 * sessions.host is the machine the session was indexed from ('' = unknown: indexed before
 * schema 4, shown as "unknown"). git_remote, repo, repo_root and cwd_git carry the session's
 * repository identity; repo_map holds directory-to-repository lines recorded per machine.
 */
export declare const SCHEMA_V4_COLUMNS: Array<[table: string, column: string, definition: string]>;
export declare const SCHEMA_V4 = "\nCREATE INDEX IF NOT EXISTS sessions_repo ON sessions(repo, end_time);\nCREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);\nCREATE INDEX IF NOT EXISTS sessions_host ON sessions(host);\n\nCREATE TABLE IF NOT EXISTS repo_map (\n  host   TEXT NOT NULL,      -- the machine the directory is on\n  dir    TEXT NOT NULL,      -- absolute work-tree root\n  root   TEXT NOT NULL,      -- its main repository root\n  remote TEXT,               -- origin URL, credentials stripped\n  at     INTEGER NOT NULL,   -- unix seconds it was recorded; a newer line replaces an older one\n  PRIMARY KEY (host, dir)\n);\n";
//# sourceMappingURL=schema-repos.d.ts.map