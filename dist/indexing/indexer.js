/**
 * Incremental, byte-offset indexing of one transcript file.
 *
 * Transcripts are append-only while a session runs, so a file that has only grown is
 * read from the stored offset, up to its last complete line. A file that shrank or was
 * replaced is indexed again from zero. Each batch of lines is written in one short
 * IMMEDIATE transaction that first re-checks the stored offset: if another process
 * indexed those bytes in the meantime, the batch is dropped, so racing indexers never
 * insert the same lines twice.
 *
 * One stored row per message. An assistant turn that Claude Code writes as several
 * lines (text, then each tool call) becomes one row, and the tool results that follow
 * it are added to that row, so a hit shows what was run next to what came back.
 *
 * Calls to this server's own tools keep their name, but neither their input nor their
 * result is indexed. Their results can arrive in a later append than the call, so the
 * calls still waiting for a result are kept with the file.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from "fs";
import { createHash } from "crypto";
import { CONFIG } from "../config.js";
import { scopeOf } from "../db/schema.js";
import { extractContent, isLocalCommandEcho, truncate } from "../parsers/content-extractor.js";
import { readLines } from "./line-reader.js";
const HEAD_BYTES = 4096;
const DEFAULT_BATCH_BYTES = 4 << 20;
/** Lines this long are parsed only when they look like a message (skips API dumps). */
const BIG_LINE = 256 << 10;
const MAX_PENDING_TOOLS = 100;
function parsePendingTools(raw) {
    try {
        const value = raw ? JSON.parse(raw) : {};
        return {
            own: Array.isArray(value.own) ? value.own.filter((id) => typeof id === "string") : [],
            textCalls: Array.isArray(value.textCalls) ? value.textCalls.map(Boolean) : [],
        };
    }
    catch {
        return { own: [], textCalls: [] };
    }
}
function serializePendingTools(pending) {
    const own = pending.own.slice(-MAX_PENDING_TOOLS);
    const textCalls = pending.textCalls.slice(-MAX_PENDING_TOOLS);
    return own.length || textCalls.length ? JSON.stringify({ own, textCalls }) : "";
}
function emptyUpdate() {
    return { minTs: null, maxTs: null, added: 0, cwd: null, branch: null, firstPrompt: null, aiTitle: null, customTitle: null };
}
function appendCapped(existing, addition, cap) {
    if (!addition)
        return existing;
    if (existing.length >= cap)
        return existing;
    const joined = existing ? `${existing}\n${addition}` : addition;
    return truncate(joined, cap);
}
function parseTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
    }
    return null;
}
function headHash(fd, length) {
    if (length <= 0)
        return "";
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return `${read}:${createHash("sha1").update(buffer.subarray(0, read)).digest("hex")}`;
}
function headMatches(fd, stored) {
    if (!stored)
        return true;
    const length = Number(stored.slice(0, stored.indexOf(":")));
    return headHash(fd, length) === stored;
}
/** Title and description of a subagent, from the meta file Claude Code writes beside it. */
function subagentTitle(file) {
    const metaPath = file.path.replace(/\.jsonl$/, ".meta.json");
    if (!existsSync(metaPath))
        return null;
    try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        const parts = [meta.agentType, meta.description].filter((p) => typeof p === "string" && !!p);
        return parts.length ? truncate(parts.join(": "), 200) : null;
    }
    catch {
        return null;
    }
}
/**
 * Builds message rows from transcript lines. Holds the last row open so that the next
 * line (another block of the same assistant turn, or a tool result) can extend it.
 */
class RowBuilder {
    pending;
    nextSeq;
    hasFirstPrompt;
    calls;
    finished = [];
    update = emptyUpdate();
    constructor(pending, nextSeq, hasFirstPrompt, calls) {
        this.pending = pending;
        this.nextSeq = nextSeq;
        this.hasFirstPrompt = hasFirstPrompt;
        this.calls = calls;
    }
    /** False for the result of a call to this server's own tools. */
    keepResult(result) {
        if (result.toolUseId !== undefined) {
            const index = this.calls.own.indexOf(result.toolUseId);
            if (index === -1)
                return true;
            this.calls.own.splice(index, 1);
            return false;
        }
        return this.calls.textCalls.shift() !== true;
    }
    start(role, ts, msgId) {
        if (this.pending)
            this.finished.push(this.pending);
        this.pending = {
            seq: this.nextSeq++, role, ts, msgId, prose: "", toolInput: "", toolOutput: "", tools: [], dirty: true,
        };
        return this.pending;
    }
    noteTime(ts) {
        if (ts === null)
            return;
        const u = this.update;
        u.minTs = u.minTs === null ? ts : Math.min(u.minTs, ts);
        u.maxTs = u.maxTs === null ? ts : Math.max(u.maxTs, ts);
    }
    addLine(obj) {
        const type = obj.type;
        if (type === "ai-title" && typeof obj.aiTitle === "string") {
            this.update.aiTitle = truncate(obj.aiTitle, 200);
            return;
        }
        if (type === "custom-title" && typeof obj.customTitle === "string") {
            this.update.customTitle = truncate(obj.customTitle, 200);
            return;
        }
        if (type !== "user" && type !== "assistant")
            return;
        if (obj.isMeta === true)
            return; // injected skill bodies and command caveats, not conversation
        const message = obj.message;
        if (!message)
            return;
        if (typeof obj.cwd === "string" && obj.cwd && !this.update.cwd)
            this.update.cwd = obj.cwd;
        if (typeof obj.gitBranch === "string" && obj.gitBranch && !this.update.branch)
            this.update.branch = obj.gitBranch;
        const ts = parseTimestamp(obj.timestamp);
        const extracted = extractContent(message.content);
        const limits = CONFIG.limits;
        this.calls.own.push(...extracted.ownCallIds);
        this.calls.textCalls.push(...extracted.textCalls);
        const results = extracted.toolResults.filter((r) => this.keepResult(r)).map((r) => r.text).filter(Boolean);
        if (type === "assistant" && (extracted.text || extracted.toolNames.length > 0)) {
            const msgId = typeof message.id === "string" ? message.id : null;
            const p = this.pending;
            const row = p && p.role === "assistant" && msgId !== null && p.msgId === msgId ? p : this.start("assistant", ts, msgId);
            if (extracted.text)
                row.prose = truncate(row.prose ? `${row.prose}\n\n${extracted.text}` : extracted.text, limits.prose);
            for (const snippet of extracted.toolInputSnippets)
                row.toolInput = appendCapped(row.toolInput, snippet, limits.toolInputTotal);
            row.tools.push(...extracted.toolNames);
            for (const result of results)
                row.toolOutput = appendCapped(row.toolOutput, result, limits.toolOutputTotal);
            row.dirty = true;
            this.noteTime(ts);
            return;
        }
        // A prompt, tool results (a user line, or a Codex result line), or both;
        // an assistant line with nothing left (thinking only, or an own tool's result) is skipped.
        if (!extracted.text && results.length === 0)
            return;
        let row;
        if (!extracted.text && this.pending && this.pending.role === "assistant") {
            row = this.pending; // results of the tool calls in the turn just before
        }
        else {
            row = this.start(extracted.text ? "user" : "tool", ts, null);
            row.prose = truncate(extracted.text, limits.prose);
            if (extracted.text && !this.hasFirstPrompt && !isLocalCommandEcho(extracted.text)) {
                this.update.firstPrompt = truncate(extracted.text.replace(/\s+/g, " "), limits.firstPrompt);
                this.hasFirstPrompt = true;
            }
        }
        for (const result of results)
            row.toolOutput = appendCapped(row.toolOutput, result, limits.toolOutputTotal);
        row.dirty = true;
        this.noteTime(ts);
    }
    /** Rows to write for this batch (finished ones plus the open one), then reset. */
    drain() {
        const rows = [...this.finished];
        if (this.pending)
            rows.push(this.pending);
        this.finished.length = 0;
        return rows.filter((r) => r.dirty);
    }
}
function isMessageLine(line) {
    if (line.length < BIG_LINE)
        return true;
    const head = line.subarray(0, 2048).toString("utf8");
    return head.includes('"type":"user"') || head.includes('"type":"assistant"');
}
function prepare(db) {
    return {
        file: db.prepare("SELECT * FROM files WHERE path = ?"),
        session: db.prepare("SELECT sid, legacy, first_prompt FROM sessions WHERE id = ?"),
        insertSession: db.prepare(`INSERT INTO sessions(id, project, source, is_subagent, parent_session, title)
       VALUES (@id, @project, @source, @isSubagent, @parent, @title) ON CONFLICT(id) DO NOTHING`),
        maxSeq: db.prepare("SELECT max(seq) AS seq FROM messages WHERE session_sid = ?"),
        tailRow: db.prepare(`SELECT m.id, m.seq, m.role, m.ts, m.tools, t.prose, t.tool_input, t.tool_output
       FROM messages m JOIN message_text t ON t.id = m.id WHERE m.id = ?`),
        insertMessage: db.prepare(`INSERT INTO messages(session_sid, seq, role, ts, tools) VALUES (@sid, @seq, @role, @ts, @tools)`),
        insertText: db.prepare(`INSERT INTO message_text(id, prose, tool_input, tool_output, scope)
       VALUES (@rowid, @prose, @toolInput, @toolOutput, @scope)`),
        updateTools: db.prepare("UPDATE messages SET tools = @tools WHERE id = @rowid"),
        updateText: db.prepare(`UPDATE message_text SET prose = @prose, tool_input = @toolInput, tool_output = @toolOutput WHERE id = @rowid`),
        updateSession: db.prepare(`UPDATE sessions SET
         start_time = CASE WHEN @minTs IS NOT NULL AND (start_time IS NULL OR start_time > @minTs) THEN @minTs ELSE start_time END,
         end_time = CASE WHEN @maxTs IS NOT NULL AND (end_time IS NULL OR end_time < @maxTs) THEN @maxTs ELSE end_time END,
         message_count = message_count + @added,
         cwd = coalesce(cwd, @cwd),
         git_branch = coalesce(git_branch, @branch),
         first_prompt = coalesce(first_prompt, @firstPrompt),
         title = coalesce(@customTitle, title, @aiTitle)
       WHERE sid = @sid`),
        upsertFile: db.prepare(`INSERT INTO files(path, session_sid, size, mtime, ino, head, offset, tail_rowid, tail_msg_id, pending_tools, indexed_at)
       VALUES (@path, @sid, @size, @mtime, @ino, @head, @offset, @tailRowid, @tailMsgId, @pendingTools, @now)
       ON CONFLICT(path) DO UPDATE SET session_sid = excluded.session_sid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, head = excluded.head, offset = excluded.offset,
         tail_rowid = excluded.tail_rowid, tail_msg_id = excluded.tail_msg_id,
         pending_tools = excluded.pending_tools, indexed_at = excluded.indexed_at`),
        touchFile: db.prepare("UPDATE files SET size = ?, mtime = ? WHERE path = ?"),
        deleteMessages: db.prepare("DELETE FROM messages WHERE session_sid = ?"),
        resetSession: db.prepare(`UPDATE sessions SET start_time = NULL, end_time = NULL, message_count = 0, first_prompt = NULL, legacy = 0
       WHERE sid = ?`),
    };
}
const statementCache = new WeakMap();
function statements(db) {
    let s = statementCache.get(db);
    if (!s) {
        s = prepare(db);
        statementCache.set(db, s);
    }
    return s;
}
/** True when the file on disk differs from what the files table recorded. */
export function hasChanged(file, row) {
    return !row || row.size !== file.size || row.mtime !== file.mtimeMs || row.ino !== file.ino;
}
function ensureSession(db, s, file) {
    const existing = s.session.get(file.sessionId);
    if (existing)
        return existing;
    db.transaction(() => {
        s.insertSession.run({
            id: file.sessionId,
            project: file.projectDir,
            source: file.source,
            isSubagent: file.isSubagent ? 1 : 0,
            parent: file.parentSessionId ?? null,
            title: file.isSubagent ? subagentTitle(file) : null,
        });
    }).immediate();
    return s.session.get(file.sessionId);
}
export function indexFile(db, file, options = {}) {
    const s = statements(db);
    const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
    const result = { status: "unchanged", reset: false, messagesAdded: 0, bytesRead: 0, complete: true };
    let fd;
    try {
        fd = openSync(file.path, "r");
    }
    catch {
        return { ...result, status: "missing" };
    }
    try {
        const session = ensureSession(db, s, file);
        result.sessionSid = session.sid;
        let row = s.file.get(file.path);
        const replaced = row !== undefined &&
            (row.ino !== file.ino || file.size < row.offset || !headMatches(fd, row.head));
        // A session imported from the old index whose transcript reappears: start it over.
        const legacyLeftover = row === undefined && session.legacy === 1;
        if (replaced || legacyLeftover) {
            const expected = row?.offset;
            const ok = db.transaction(() => {
                const current = s.file.get(file.path);
                if (current?.offset !== expected)
                    return false;
                s.deleteMessages.run(session.sid);
                s.resetSession.run(session.sid);
                s.upsertFile.run({
                    path: file.path, sid: session.sid, size: 0, mtime: 0, ino: file.ino, head: "", offset: 0,
                    tailRowid: null, tailMsgId: null, pendingTools: "", now: Date.now(),
                });
                return true;
            }).immediate();
            if (!ok)
                return { ...result, status: "raced" };
            result.reset = true;
            session.first_prompt = null;
            row = s.file.get(file.path);
        }
        let offset = row?.offset ?? 0;
        if (row && !result.reset && offset >= file.size) {
            if (row.size !== file.size || row.mtime !== file.mtimeMs)
                s.touchFile.run(file.size, file.mtimeMs, file.path);
            return result;
        }
        // Reopen the row this file last wrote, so its turn can keep growing.
        let pending = null;
        if (row?.tail_rowid) {
            const tail = s.tailRow.get(row.tail_rowid);
            if (tail) {
                pending = {
                    rowid: tail.id, seq: tail.seq, role: tail.role, ts: tail.ts, msgId: row.tail_msg_id, prose: tail.prose,
                    toolInput: tail.tool_input, toolOutput: tail.tool_output, tools: tail.tools ? tail.tools.split(" ") : [], dirty: false,
                };
            }
        }
        const maxSeq = s.maxSeq.get(session.sid).seq;
        const builder = new RowBuilder(pending, maxSeq === null ? 0 : maxSeq + 1, !!session.first_prompt, parsePendingTools(row?.pending_tools));
        let head = row?.head ?? "";
        for (;;) {
            const batch = readLines(fd, offset, batchBytes);
            const end = batch.end;
            if (end === offset)
                break;
            for (const line of batch.lines) {
                if (!isMessageLine(line))
                    continue;
                let obj;
                try {
                    obj = JSON.parse(line.toString("utf8"));
                }
                catch {
                    continue; // a malformed line is skipped, never retried
                }
                builder.addLine(obj);
            }
            const rows = builder.drain();
            const update = builder.update;
            builder.update = emptyUpdate();
            if (head.length === 0 || Number(head.slice(0, head.indexOf(":"))) < Math.min(HEAD_BYTES, end)) {
                head = headHash(fd, Math.min(HEAD_BYTES, end));
            }
            options.beforeCommit?.();
            const start = offset;
            const committed = db.transaction(() => {
                const current = s.file.get(file.path);
                if ((current?.offset ?? 0) !== start || (current && current.ino !== file.ino))
                    return false;
                let added = 0;
                for (const r of rows) {
                    const text = { prose: r.prose, toolInput: r.toolInput, toolOutput: r.toolOutput };
                    const tools = r.tools.join(" ");
                    if (r.rowid !== undefined) {
                        s.updateTools.run({ tools, rowid: r.rowid });
                        s.updateText.run({ ...text, rowid: r.rowid });
                    }
                    else {
                        r.rowid = Number(s.insertMessage.run({ tools, sid: session.sid, seq: r.seq, role: r.role, ts: r.ts }).lastInsertRowid);
                        s.insertText.run({ ...text, rowid: r.rowid, scope: scopeOf(session.sid, r.role) });
                        added++;
                    }
                    r.dirty = false;
                }
                s.updateSession.run({ ...update, added, sid: session.sid });
                const tail = builder.pending;
                s.upsertFile.run({
                    // Stopping early records the size reached, so the file still reads as changed.
                    path: file.path, sid: session.sid, size: batch.eof ? file.size : end, mtime: file.mtimeMs, ino: file.ino, head, offset: end,
                    tailRowid: tail?.rowid ?? null, tailMsgId: tail?.msgId ?? null,
                    pendingTools: serializePendingTools(builder.calls), now: Date.now(),
                });
                result.messagesAdded += added;
                return true;
            }).immediate();
            if (!committed)
                return { ...result, status: "raced" };
            result.status = "indexed";
            result.bytesRead += end - offset;
            offset = end;
            if (batch.eof)
                break;
            if (options.deadline !== undefined && Date.now() > options.deadline) {
                result.complete = false;
                break;
            }
        }
        if (result.status === "unchanged" && row && (row.size !== file.size || row.mtime !== file.mtimeMs)) {
            s.touchFile.run(file.size, file.mtimeMs, file.path);
        }
        return result;
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=indexer.js.map