/**
 * Keeping the database fresh: the full sweep (run by a scheduled job) and the small,
 * time-boxed top-up a server may do before answering a search.
 */
import { statSync } from "fs";
import { CONFIG } from "../config.js";
import { getMeta, isBusyError, setMeta, withBusyTimeout } from "../db/database.js";
import { extractKnowledge } from "../knowledge/knowledge-extractor.js";
import { replaceSessionKnowledge } from "../knowledge/knowledge-store.js";
import { loadParsedSession } from "../knowledge/parsed-session.js";
import { saveSummary, summarizeSession } from "../knowledge/session-summarizer.js";
import { listSubagentFiles, listTranscripts } from "../parsers/transcript-files.js";
import { hasChanged, indexFile, noDuplicates } from "./indexer.js";
import { indexingOrder } from "./line-keys.js";
/** Run FTS5 'optimize' once this many messages have been added since the last one. */
const OPTIMIZE_AFTER_MESSAGES = 50_000;
/** VACUUM when more than this share of the file is free pages (after a migration, say)... */
const VACUUM_FREE_SHARE = 0.25;
/**
 * ...or when this share of all messages arrived since the last VACUUM. Rows written as
 * transcripts grow interleave the small `messages` pages with the large text pages; a
 * search reads the small table, and on a cold cache reading it scattered across the file
 * costs about twice as long as reading it laid out together (measured: 130 vs 32 ms).
 */
const VACUUM_NEW_SHARE = 0.1;
/** A lock older than this is taken over even if its pid is (or was reused as) alive. */
const STALE_LOCK_MS = 6 * 60 * 60_000;
function knownFiles(db) {
    const rows = db.prepare("SELECT path, size, mtime, ino FROM files").all();
    return new Map(rows.map((r) => [r.path, r]));
}
/** Transcripts whose size, mtime or inode differ from what was last indexed. */
export function changedTranscripts(db) {
    const known = knownFiles(db);
    const files = listTranscripts();
    const changed = files.filter((f) => hasChanged(f, known.get(f.path)));
    changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { all: files.length, changed, files };
}
// ---------------------------------------------------------------- locking
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
/** Take a named lock in the database. Returns the live holder when someone else has it. */
export function acquireLock(db, name) {
    return db.transaction(() => {
        const holder = db.prepare("SELECT pid, acquired FROM locks WHERE name = ?").get(name);
        if (holder && holder.pid !== process.pid && isAlive(holder.pid) && Date.now() - holder.acquired < STALE_LOCK_MS) {
            return holder;
        }
        db.prepare("INSERT INTO locks(name, pid, acquired) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET pid = excluded.pid, acquired = excluded.acquired").run(name, process.pid, Date.now());
        return null;
    }).immediate();
}
export function releaseLock(db, name) {
    db.prepare("DELETE FROM locks WHERE name = ? AND pid = ?").run(name, process.pid);
}
export class SweepBusyError extends Error {
    holder;
    constructor(holder) {
        super(`Another sweep (pid ${holder.pid}) has been running since ${new Date(holder.acquired).toISOString()}.`);
        this.holder = holder;
        this.name = "SweepBusyError";
    }
}
function databaseBytes(db) {
    let total = 0;
    for (const suffix of ["", "-wal"]) {
        try {
            total += statSync(db.name + suffix).size;
        }
        catch {
            // no WAL file yet
        }
    }
    return total;
}
/** Re-summarise and re-extract knowledge for sessions that gained messages. */
function refreshKnowledge(db, sids) {
    let count = 0;
    const isTopLevel = db.prepare("SELECT is_subagent FROM sessions WHERE sid = ?");
    for (const sid of sids) {
        const row = isTopLevel.get(sid);
        if (!row || row.is_subagent)
            continue; // subagent turns are noise at session start
        const session = loadParsedSession(db, sid);
        if (!session || session.messages.length === 0)
            continue;
        db.transaction(() => {
            saveSummary(db, summarizeSession(session));
            replaceSessionKnowledge(db, session.sessionId, extractKnowledge(session));
        }).immediate();
        count++;
    }
    return count;
}
/** Count new messages towards the next VACUUM. */
export function noteNewMessages(db, added) {
    setMeta(db, "messages_since_vacuum", String(Number(getMeta(db, "messages_since_vacuum") ?? 0) + added));
}
function vacuumIfWorthwhile(db, added, totalMessages) {
    noteNewMessages(db, added);
    const sinceVacuum = Number(getMeta(db, "messages_since_vacuum") ?? 0);
    const free = db.pragma("freelist_count", { simple: true });
    const pages = db.pragma("page_count", { simple: true });
    const mostlyFree = pages > 0 && free / pages > VACUUM_FREE_SHARE;
    const muchNew = totalMessages > 0 && sinceVacuum / totalMessages >= VACUUM_NEW_SHARE;
    if (!mostlyFree && !muchNew)
        return false;
    // VACUUM builds a whole copy of the database in temp storage: on disk, not in memory.
    const tempStore = db.pragma("temp_store", { simple: true });
    db.pragma("temp_store = FILE");
    try {
        db.exec("VACUUM");
    }
    catch (error) {
        if (isBusyError(error))
            return false; // another writer is busy: try again next sweep
        throw error;
    }
    finally {
        db.pragma(`temp_store = ${tempStore}`);
    }
    setMeta(db, "messages_since_vacuum", "0");
    return true;
}
export function sweep(db, options = {}) {
    const started = Date.now();
    const holder = acquireLock(db, "sweep");
    if (holder)
        throw new SweepBusyError(holder);
    try {
        const { all, changed, files } = changedTranscripts(db);
        const stats = {
            transcripts: all, changed: changed.length, indexed: 0, reset: 0, raced: 0, vanished: 0, messagesAdded: 0,
            bytesRead: 0, summarized: 0, optimized: false, vacuumed: false, sessions: 0, messages: 0, databaseBytes: 0, ms: 0,
            duplicates: noDuplicates(),
        };
        const touched = new Set();
        let lastReport = Date.now();
        // Claude files in a fixed order (line-keys.ts, indexingOrder): the session that existed first
        // keeps the lines a later fork copied, in every sweep and in a rebuild alike, unless the fork
        // was indexed in an earlier run (a top-up, or an original pushed later).
        const queue = indexingOrder(changed, options.lineHolder);
        /** Paths still to read in this sweep. */
        const pending = new Set(queue.map((f) => f.path));
        const byPath = new Map(files.map((f) => [f.path, f]));
        const otherFiles = db.prepare("SELECT path FROM files WHERE session_sid = ? AND path <> ? ORDER BY path").pluck();
        for (let i = 0; i < queue.length; i++) {
            const file = queue[i];
            pending.delete(file.path);
            const result = indexFile(db, file);
            for (const k of Object.keys(stats.duplicates))
                stats.duplicates[k] += result.duplicates[k];
            if (result.status === "indexed")
                stats.indexed++;
            if (result.status === "raced")
                stats.raced++;
            if (result.status === "missing")
                stats.vanished++;
            if (result.reset)
                stats.reset++;
            stats.messagesAdded += result.messagesAdded;
            stats.bytesRead += result.bytesRead;
            if (result.sessionSid !== undefined && (result.messagesAdded > 0 || result.reset))
                touched.add(result.sessionSid);
            // A session read again from scratch: its other files (a twin under another project path)
            // were set back to their start, so they are read in this sweep too, not the next.
            if (result.reset && result.sessionSid !== undefined) {
                for (const path of otherFiles.all(result.sessionSid, file.path)) {
                    const other = byPath.get(path);
                    if (other && !pending.has(path)) {
                        pending.add(path);
                        queue.push(other);
                    }
                }
            }
            if (options.progress && Date.now() - lastReport > 5_000) {
                lastReport = Date.now();
                options.progress(`  ${i + 1}/${queue.length} transcripts, ${stats.messagesAdded.toLocaleString("en-US")} messages added`);
            }
        }
        stats.summarized = refreshKnowledge(db, touched);
        const sinceOptimize = Number(getMeta(db, "messages_since_optimize") ?? 0) + stats.messagesAdded;
        if (sinceOptimize >= OPTIMIZE_AFTER_MESSAGES) {
            db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')").run();
            stats.optimized = true;
            setMeta(db, "messages_since_optimize", "0");
        }
        else {
            setMeta(db, "messages_since_optimize", String(sinceOptimize));
        }
        const totals = db.prepare("SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM messages) AS messages").get();
        stats.vacuumed = vacuumIfWorthwhile(db, stats.messagesAdded, totals.messages);
        stats.sessions = totals.sessions;
        stats.messages = totals.messages;
        stats.ms = Date.now() - started;
        setMeta(db, "last_sweep", String(Date.now()));
        setMeta(db, "last_sweep_stats", JSON.stringify(stats));
        try {
            db.pragma("wal_checkpoint(TRUNCATE)");
        }
        catch {
            // readers busy: the next checkpoint will catch up
        }
        stats.databaseBytes = databaseBytes(db);
        return stats;
    }
    finally {
        releaseLock(db, "sweep");
    }
}
/**
 * Index transcripts changed since the last sweep, newest first, until the budget is
 * spent. Cheap to call: it stats top-level files only, and walks subagent directories
 * only of sessions whose own transcript changed.
 */
export function topUp(db, budgetMs = CONFIG.topUpBudgetMs) {
    const started = Date.now();
    const known = knownFiles(db);
    const changed = [];
    for (const file of listTranscripts({ includeSubagentsOf: () => false })) {
        if (!hasChanged(file, known.get(file.path)))
            continue;
        changed.push(file);
        for (const sub of listSubagentFiles(file)) {
            if (hasChanged(sub, known.get(sub.path)))
                changed.push(sub);
        }
    }
    changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let indexed = 0;
    if (budgetMs > 0) {
        const deadline = started + budgetMs;
        for (const file of changed) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            try {
                const result = withBusyTimeout(db, remaining, () => indexFile(db, file, { deadline, batchBytes: 1 << 20 }));
                if (result.complete && result.status !== "raced")
                    indexed++;
            }
            catch (error) {
                if (isBusyError(error))
                    break; // a sweep holds the write lock: leave the rest to it
                throw error;
            }
        }
    }
    return { indexed, behind: changed.length - indexed, ms: Date.now() - started };
}
//# sourceMappingURL=sweep.js.map