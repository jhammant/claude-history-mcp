/**
 * One-time import of the pre-SQLite store: sessions in index.msgpack whose transcripts
 * are gone (as archived chunk rows), every cached summary and the knowledge file.
 * Idempotent: sessions already in the database, summaries already stored and known
 * knowledge entries are skipped.
 *
 * The old index unpacks to several GB, so run this in its own process with a raised
 * heap limit (the CLI re-launches itself with one) and never beside another heavy job.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { CONFIG } from "../config.js";
import { setMeta } from "../db/database.js";
import { scopeOf } from "../db/schema.js";
import { insertKnowledge } from "../knowledge/knowledge-store.js";
import { listTranscripts } from "../parsers/transcript-files.js";
import { noteNewMessages } from "./sweep.js";
async function readLegacyChunks(path) {
    const { unpack } = await import("msgpackr");
    const data = unpack(readFileSync(path));
    return data.documents?.documents ?? [];
}
function importChunks(db, chunks, stats) {
    const bySession = new Map();
    for (const chunk of chunks) {
        if (!chunk || typeof chunk.sessionId !== "string" || typeof chunk.text !== "string")
            continue;
        const list = bySession.get(chunk.sessionId);
        if (list)
            list.push(chunk);
        else
            bySession.set(chunk.sessionId, [chunk]);
    }
    stats.sessionsInIndex = bySession.size;
    const onDisk = new Set(listTranscripts().map((f) => f.sessionId));
    const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
    const insertSession = db.prepare(`INSERT INTO sessions(id, project, source, is_subagent, first_prompt, start_time, end_time, message_count, legacy)
     VALUES (@id, @project, @source, 0, @firstPrompt, @start, @end, @count, 1)`);
    const insertMessage = db.prepare("INSERT INTO messages(session_sid, seq, role, ts, tools) VALUES (?, ?, ?, ?, ?)");
    const insertText = db.prepare("INSERT INTO message_text(id, prose, scope) VALUES (?, ?, ?)");
    for (const [sessionId, list] of bySession) {
        if (onDisk.has(sessionId)) {
            stats.sessionsSkippedOnDisk++;
            continue;
        }
        if (exists.get(sessionId)) {
            stats.sessionsSkippedExisting++;
            continue;
        }
        list.sort((a, b) => a.id - b.id);
        const times = list.map((c) => c.timestamp).filter((t) => typeof t === "number" && t > 0);
        const opening = list.find((c) => c.role !== "assistant") ?? list[0];
        db.transaction(() => {
            const sid = Number(insertSession.run({
                id: sessionId,
                project: list[0].project ?? "",
                source: sessionId.startsWith("codex-") ? "codex" : "claude",
                firstPrompt: opening.text.replace(/\s+/g, " ").slice(0, CONFIG.limits.firstPrompt),
                start: times.length ? Math.min(...times) : null,
                end: times.length ? Math.max(...times) : null,
                count: list.length,
            }).lastInsertRowid);
            list.forEach((chunk, seq) => {
                const id = insertMessage.run(sid, seq, chunk.role, chunk.timestamp || null, (chunk.toolNames ?? []).join(" ")).lastInsertRowid;
                insertText.run(id, chunk.text, scopeOf(sid, chunk.role));
            });
        })();
        stats.sessionsImported++;
        stats.rowsImported += list.length;
    }
}
function importSummaries(db) {
    const dir = CONFIG.legacy.summariesDir;
    if (!existsSync(dir))
        return 0;
    const insert = db.prepare("INSERT OR IGNORE INTO summaries(session_id, project, end_time, data) VALUES (?, ?, ?, ?)");
    let imported = 0;
    db.transaction(() => {
        for (const file of readdirSync(dir)) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const raw = readFileSync(join(dir, file), "utf8");
                const summary = JSON.parse(raw);
                const sessionId = summary.sessionId ?? file.replace(/\.json$/, "");
                if (typeof summary.project !== "string")
                    continue;
                imported += insert.run(sessionId, summary.project, Number(summary.endTime) || 0, raw).changes;
            }
            catch {
                // unreadable summary: skipped
            }
        }
    })();
    return imported;
}
function importKnowledge(db) {
    const file = CONFIG.legacy.knowledgeFile;
    if (!existsSync(file))
        return 0;
    try {
        const entries = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(entries))
            return 0;
        return db.transaction(() => insertKnowledge(db, entries))();
    }
    catch {
        return 0;
    }
}
export async function importLegacy(db) {
    const started = Date.now();
    const stats = {
        chunksInIndex: 0, sessionsInIndex: 0, sessionsImported: 0, rowsImported: 0, sessionsSkippedOnDisk: 0,
        sessionsSkippedExisting: 0, summariesImported: 0, knowledgeImported: 0, ms: 0,
    };
    if (existsSync(CONFIG.legacy.indexFile)) {
        const chunks = await readLegacyChunks(CONFIG.legacy.indexFile);
        stats.chunksInIndex = chunks.length;
        importChunks(db, chunks, stats);
    }
    noteNewMessages(db, stats.rowsImported); // the next sweep compacts the file around them
    stats.summariesImported = importSummaries(db);
    stats.knowledgeImported = importKnowledge(db);
    stats.ms = Date.now() - started;
    setMeta(db, "legacy_import", JSON.stringify({ at: Date.now(), ...stats }));
    return stats;
}
//# sourceMappingURL=legacy-import.js.map