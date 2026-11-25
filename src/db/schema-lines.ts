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
export const SCHEMA_V3_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ["sessions", "index_rev", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "context_copied", "INTEGER NOT NULL DEFAULT 0"],
];

export const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS line_uuids (
  uuid        BLOB PRIMARY KEY,   -- 16 bytes: the line's uuid (a non-uuid string: its sha256, cut to 16)
  session_sid INTEGER NOT NULL    -- the session whose messages hold the line
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS line_uuids_session ON line_uuids(session_sid);

CREATE TABLE IF NOT EXISTS line_uuid_cutoffs (
  session_sid INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL    -- newest line timestamp the session had indexed before v3
);
INSERT OR IGNORE INTO line_uuid_cutoffs(session_sid, ts)
  SELECT sid, end_time FROM sessions WHERE source = 'claude' AND message_count > 0 AND end_time IS NOT NULL;

-- Any path that empties a session of its messages frees its lines for indexing again.
CREATE TRIGGER IF NOT EXISTS messages_ad_line_uuids AFTER DELETE ON messages
WHEN NOT EXISTS (SELECT 1 FROM messages WHERE session_sid = old.session_sid) BEGIN
  DELETE FROM line_uuids WHERE session_sid = old.session_sid;
  DELETE FROM line_uuid_cutoffs WHERE session_sid = old.session_sid;
END;
`;
