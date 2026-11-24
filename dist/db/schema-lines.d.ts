/**
 * Schema v3: each Claude transcript line is indexed at most once (src/indexing/indexer.ts).
 *
 * line_uuids holds the `uuid` of every Claude user/assistant line indexed, as 16 bytes, with
 * the session that holds it. A line whose uuid is already there is skipped, whichever file or
 * session it appears in: the same session file kept under two spellings of one project path,
 * and a forked session's (or sibling subagent's) copy of the history it started from. Rows
 * are dropped with their session's messages (the indexer's reset, and by trigger when a
 * session's last message goes).
 *
 * sessions.index_rev counts the indexing commits that changed a session. A session fed by two
 * files has one stream of rows, so an indexer re-checks it before writing, as it re-checks its
 * file's offset.
 *
 * sessions.context_copied marks cwd (1) and git_branch (2) taken from lines the
 * session skipped because another session holds them: a fork's copied history says where the
 * original ran. They only fill a gap; the session's own lines replace them when they state one.
 *
 * line_uuid_cutoffs bridges the upgrade: the lines indexed before v3 have no uuids, so a copy
 * that is behind its twin would add them again. For each Claude session with messages it keeps
 * the newest timestamp indexed before v3; a line no newer than that, read from a file at a
 * position another file of the session has already passed, is taken as indexed. A rebuild
 * starts without it (the fresh database records every uuid).
 */
export declare const SCHEMA_V3_COLUMNS: Array<[table: string, column: string, definition: string]>;
export declare const SCHEMA_V3 = "\nCREATE TABLE IF NOT EXISTS line_uuids (\n  uuid        BLOB PRIMARY KEY,   -- 16 bytes: the line's uuid (a non-uuid string: its sha256, cut to 16)\n  session_sid INTEGER NOT NULL    -- the session whose messages hold the line\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS line_uuids_session ON line_uuids(session_sid);\n\nCREATE TABLE IF NOT EXISTS line_uuid_cutoffs (\n  session_sid INTEGER PRIMARY KEY,\n  ts          INTEGER NOT NULL    -- newest line timestamp the session had indexed before v3\n);\nINSERT OR IGNORE INTO line_uuid_cutoffs(session_sid, ts)\n  SELECT sid, end_time FROM sessions WHERE source = 'claude' AND message_count > 0 AND end_time IS NOT NULL;\n\n-- Any path that empties a session of its messages frees its lines for indexing again.\nCREATE TRIGGER IF NOT EXISTS messages_ad_line_uuids AFTER DELETE ON messages\nWHEN NOT EXISTS (SELECT 1 FROM messages WHERE session_sid = old.session_sid) BEGIN\n  DELETE FROM line_uuids WHERE session_sid = old.session_sid;\n  DELETE FROM line_uuid_cutoffs WHERE session_sid = old.session_sid;\nEND;\n";
//# sourceMappingURL=schema-lines.d.ts.map