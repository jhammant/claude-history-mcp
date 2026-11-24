/**
 * Build a fresh database from the transcripts beside the live one, carry over every
 * session the transcripts no longer have (the archive), then swap it in.
 *
 * The swap uses SQLite's online backup into the live file rather than a rename: servers
 * keep the live file open, and renaming a WAL database under open connections can pair
 * the new file with the old WAL. The backup replaces every page in one write
 * transaction, so a reader sees either the old database or the new one.
 */
import { existsSync, rmSync } from "fs";
import { openDatabase } from "../db/database.js";
import { scopeOf } from "../db/schema.js";
import { acquireLock, releaseLock, sweep, SweepBusyError } from "./sweep.js";
/** Every sessions column but sid (v3: index_rev, context_copied). */
const SESSION_COLUMNS = "id, project, cwd, git_branch, source, is_subagent, parent_session, title, first_prompt, start_time, end_time, message_count, legacy, " +
    "index_rev, context_copied";
function carryArchive(fresh, oldPath) {
    fresh.prepare("ATTACH DATABASE ? AS old").run(oldPath);
    try {
        const missing = fresh
            .prepare(`SELECT sid FROM old.sessions WHERE id NOT IN (SELECT id FROM main.sessions)`)
            .all();
        let messages = 0;
        const copySession = fresh.prepare(`INSERT INTO main.sessions(${SESSION_COLUMNS}) SELECT ${SESSION_COLUMNS} FROM old.sessions WHERE sid = ?`);
        const oldMessages = fresh.prepare(`SELECT m.seq, m.role, m.ts, m.tools, t.prose, t.tool_input, t.tool_output
       FROM old.messages m JOIN old.message_text t ON t.id = m.id WHERE m.session_sid = ? ORDER BY m.seq`);
        const insertMessage = fresh.prepare("INSERT INTO main.messages(session_sid, seq, role, ts, tools) VALUES (?, ?, ?, ?, ?)");
        const insertText = fresh.prepare("INSERT INTO main.message_text(id, prose, tool_input, tool_output, scope) VALUES (?, ?, ?, ?, ?)");
        // Their lines' uuids, so a transcript that copied those lines does not add them again.
        const copyUuids = fresh.prepare("INSERT OR IGNORE INTO main.line_uuids(uuid, session_sid) SELECT uuid, ? FROM old.line_uuids WHERE session_sid = ?");
        const countUuids = fresh.prepare("SELECT count(*) FROM old.line_uuids WHERE session_sid = ?").pluck();
        let sharedLines = 0;
        for (const { sid } of missing) {
            fresh.transaction(() => {
                const newSid = Number(copySession.run(sid).lastInsertRowid);
                sharedLines += countUuids.get(sid) - copyUuids.run(newSid, sid).changes;
                // The FTS scope names the session's id in this database, so each row is rewritten.
                for (const row of oldMessages.all(sid)) {
                    const id = insertMessage.run(newSid, row.seq, row.role, row.ts, row.tools).lastInsertRowid;
                    insertText.run(id, row.prose, row.tool_input, row.tool_output, scopeOf(newSid, row.role));
                    messages++;
                }
            })();
        }
        fresh.transaction(() => {
            fresh.exec("INSERT OR IGNORE INTO main.summaries SELECT * FROM old.summaries");
            fresh.exec(`INSERT OR IGNORE INTO main.knowledge(type, project, session_id, ts, summary, details, tags, related_files)
         SELECT type, project, session_id, ts, summary, details, tags, related_files FROM old.knowledge`);
            fresh.exec("INSERT OR IGNORE INTO main.meta SELECT * FROM old.meta WHERE key LIKE 'legacy_%'");
        })();
        return { sessions: missing.length, messages, sharedLines };
    }
    finally {
        fresh.exec("DETACH DATABASE old");
    }
}
export async function rebuild(livePath, progress) {
    const tempPath = `${livePath}.rebuild`;
    const live = existsSync(livePath) ? openDatabase(livePath) : null;
    if (live) {
        const holder = acquireLock(live, "sweep");
        if (holder) {
            live.close();
            throw new SweepBusyError(holder);
        }
    }
    try {
        for (const suffix of ["", "-wal", "-shm"])
            rmSync(tempPath + suffix, { force: true });
        const fresh = openDatabase(tempPath, { create: true });
        try {
            progress?.("Indexing every transcript into a fresh database…");
            // An exact tie in the indexing order (line-keys.ts) keeps the owner the live database had.
            const held = live?.prepare("SELECT s.id FROM line_uuids u JOIN sessions s ON s.sid = u.session_sid WHERE u.uuid = ?").pluck();
            const lineHolder = held ? (key) => held.get(key) : undefined;
            const stats = sweep(fresh, { progress, lineHolder });
            const carried = live ? carryArchive(fresh, livePath) : { sessions: 0, messages: 0, sharedLines: 0 };
            fresh.pragma("wal_checkpoint(TRUNCATE)");
            progress?.("Swapping it in…");
            await fresh.backup(livePath);
            return {
                sweep: stats, carriedSessions: carried.sessions, carriedMessages: carried.messages, carriedSharedLines: carried.sharedLines,
            };
        }
        finally {
            fresh.close();
            for (const suffix of ["", "-wal", "-shm"])
                rmSync(tempPath + suffix, { force: true });
        }
    }
    finally {
        if (live) {
            releaseLock(live, "sweep");
            live.close();
        }
    }
}
//# sourceMappingURL=rebuild.js.map