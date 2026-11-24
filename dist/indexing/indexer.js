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
 *
 * A Claude line is indexed at most once across the database, keyed by its uuid (line-keys.ts):
 * Claude Code copies a session's history into a forked session's file, and the same session
 * file can be found under two spellings of one project path. The copies are skipped, so a
 * search finds the text once, in the session that had it first.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from "fs";
import { createHash } from "crypto";
import { CONFIG } from "../config.js";
import { scopeOf } from "../db/schema.js";
import { extractContent, isLocalCommandEcho, truncate } from "../parsers/content-extractor.js";
import { formatOf } from "../formats/registry.js";
import { claudeProjectDir, UNKNOWN_PROJECT } from "../utils/path-encoder.js";
import { implicitRepoKey, REPO_NEW_DIR_KEY, repoResolver } from "../repos/resolve.js";
import { stripRemoteCredentials } from "../repos/url.js";
import { lineKey } from "./line-keys.js";
import { readLines } from "./line-reader.js";
const HEAD_BYTES = 4096;
const DEFAULT_BATCH_BYTES = 4 << 20;
/** Lines this long are parsed only when their format says they look like a message (skips API dumps). */
const BIG_LINE = 256 << 10;
export function noDuplicates() {
    return { sameSession: 0, otherSession: 0, beforeUpgrade: 0 };
}
/** Thrown inside a write transaction to roll it back: another indexer took a line first. */
const RACED = new Error("raced");
const MAX_PENDING_TOOLS = 100;
export function parsePendingTools(raw) {
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
    return {
        gitRemote: null, minTs: null, maxTs: null, added: 0, cwd: null, branch: null, firstPrompt: null, aiTitle: null, customTitle: null,
        cwdGit: 0, copiedCwd: null, copiedBranch: null, copiedGitRemote: null, copiedCwdGit: 0,
    };
}
/** sessions.context_copied bits: the stored value came from copied lines, not the session's own. */
const COPIED_CWD = 1;
const COPIED_BRANCH = 2;
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
export class RowBuilder {
    pending;
    nextSeq;
    hasFirstPrompt;
    calls;
    finished = [];
    update = emptyUpdate();
    /**
     * The session's own cwd: the stored one when the session has it, else the first cwd read. Git
     * evidence counts for it only from a line at that cwd, since a session that started in a
     * folder and moved into a repository records the folder as its cwd and the repository's branch.
     */
    sessionCwd = null;
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
    /**
     * Where a line was written (cwd and git branch) as session metadata. Never its time or prompt.
     */
    noteContext(obj) {
        // A cwd the format states for the whole session (a Codex fork's header) wins over the line's.
        if (typeof obj.sessionCwd === "string" && obj.sessionCwd) {
            if (!this.update.cwd)
                this.update.cwd = obj.sessionCwd;
            if (!this.sessionCwd)
                this.sessionCwd = obj.sessionCwd;
        }
        if (typeof obj.cwd === "string" && obj.cwd && !this.update.cwd)
            this.update.cwd = obj.cwd;
        if (typeof obj.gitBranch === "string" && obj.gitBranch && !this.update.branch)
            this.update.branch = obj.gitBranch;
        if (typeof obj.gitRemote === "string" && obj.gitRemote && !this.update.gitRemote)
            this.update.gitRemote = obj.gitRemote;
        // A session-level remote on a line at another directory (the Codex header's, see
        // codex-rollout.ts): the session's remote, but no evidence for this line's cwd.
        if (typeof obj.sessionGitRemote === "string" && obj.sessionGitRemote && !this.update.gitRemote) {
            this.update.gitRemote = obj.sessionGitRemote;
        }
        const lineCwd = typeof obj.cwd === "string" && obj.cwd ? obj.cwd : null;
        if (lineCwd && !this.sessionCwd)
            this.sessionCwd = lineCwd;
        if (lineCwd && lineCwd === this.sessionCwd &&
            ((typeof obj.gitBranch === "string" && obj.gitBranch) || (typeof obj.gitRemote === "string" && obj.gitRemote))) {
            this.update.cwdGit = 1;
        }
    }
    /**
     * Where a line skipped because another session holds it was written: a fallback for a fork
     * whose own lines do not say (a session's own lines always win, see updateSession).
     */
    noteCopied(obj) {
        const u = this.update;
        const lineCwd = typeof obj.cwd === "string" && obj.cwd ? obj.cwd : null;
        if (lineCwd && !u.copiedCwd)
            u.copiedCwd = lineCwd;
        if (typeof obj.gitBranch === "string" && obj.gitBranch && !u.copiedBranch)
            u.copiedBranch = obj.gitBranch;
        if (typeof obj.gitRemote === "string" && obj.gitRemote && !u.copiedGitRemote)
            u.copiedGitRemote = obj.gitRemote;
        if (lineCwd && lineCwd === u.copiedCwd &&
            ((typeof obj.gitBranch === "string" && obj.gitBranch) || (typeof obj.gitRemote === "string" && obj.gitRemote))) {
            u.copiedCwdGit = 1;
        }
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
        // The task a forked Codex subagent was given (see codex-rollout.ts): its first prompt, no row.
        if (type === "first-prompt" && typeof obj.text === "string") {
            if (!this.hasFirstPrompt && obj.text.trim()) {
                this.update.firstPrompt = truncate(obj.text.replace(/\s+/g, " "), CONFIG.limits.firstPrompt);
                this.hasFirstPrompt = true;
            }
            return;
        }
        if (type !== "user" && type !== "assistant")
            return;
        if (obj.isMeta === true)
            return; // injected skill bodies and command caveats, not conversation
        const message = obj.message;
        if (!message)
            return;
        this.noteContext(obj);
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
    /**
     * Lines were skipped because another session holds them (a fork's copied history): the
     * open row is closed, so a line after the gap starts a row of its own instead of joining
     * one from before it.
     */
    detach() {
        if (this.pending)
            this.finished.push(this.pending);
        this.pending = null;
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
function prepare(db) {
    return {
        file: db.prepare("SELECT * FROM files WHERE path = ?"),
        otherFile: db.prepare(`SELECT 1 FROM files f JOIN sessions s ON s.sid = f.session_sid WHERE s.id = ? AND f.path <> ?`),
        session: db.prepare("SELECT sid, legacy, first_prompt, cwd, project, index_rev, context_copied FROM sessions WHERE id = ?"),
        rev: db.prepare("SELECT index_rev FROM sessions WHERE sid = ?").pluck(),
        uuidOwner: db.prepare("SELECT session_sid FROM line_uuids WHERE uuid = ?").pluck(),
        insertUuid: db.prepare("INSERT INTO line_uuids(uuid, session_sid) VALUES (?, ?) ON CONFLICT(uuid) DO NOTHING"),
        deleteUuids: db.prepare("DELETE FROM line_uuids WHERE session_sid = ?"),
        cutoff: db.prepare("SELECT ts FROM line_uuid_cutoffs WHERE session_sid = ?").pluck(),
        deleteCutoff: db.prepare("DELETE FROM line_uuid_cutoffs WHERE session_sid = ?"),
        otherOffset: db.prepare("SELECT max(offset) FROM files WHERE session_sid = ? AND path <> ?").pluck(),
        latestOtherFile: db.prepare("SELECT * FROM files WHERE session_sid = ? AND path <> ? ORDER BY indexed_at DESC, path LIMIT 1"),
        shareTail: db.prepare(`UPDATE files SET tail_rowid = @tailRowid, tail_msg_id = @tailMsgId, pending_tools = @pendingTools
       WHERE session_sid = @sid AND path <> @path`),
        rereadOtherFiles: db.prepare(`UPDATE files SET size = 0, mtime = 0, offset = 0, head = '', tail_rowid = NULL, tail_msg_id = NULL, pending_tools = ''
       WHERE session_sid = ? AND path <> ?`),
        insertSession: db.prepare(`INSERT INTO sessions(id, project, source, is_subagent, parent_session, title, host)
       VALUES (@id, @project, @source, @isSubagent, @parent, @title, @host) ON CONFLICT(id) DO NOTHING`),
        setProject: db.prepare("UPDATE sessions SET project = ? WHERE sid = ? AND project = ?"),
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
         -- Set once, from the session's own lines. Values from copied lines (context_copied bits
         -- 1 cwd, 2 branch, 4 remote) only fill a gap, and the session's own value replaces them.
         -- The SET expressions all read the row as it was before this update.
         cwd = CASE WHEN @cwd IS NOT NULL AND (cwd IS NULL OR context_copied & 1) THEN @cwd
                    WHEN cwd IS NULL THEN @copiedCwd ELSE cwd END,
         git_branch = CASE WHEN @branch IS NOT NULL AND (git_branch IS NULL OR context_copied & 2) THEN @branch
                           WHEN git_branch IS NULL THEN @copiedBranch ELSE git_branch END,
         git_remote = CASE WHEN @gitRemote IS NOT NULL AND (git_remote IS NULL OR context_copied & 4) THEN @gitRemote
                           WHEN git_remote IS NULL THEN @copiedGitRemote ELSE git_remote END,
         -- Git evidence at whichever cwd is in use.
         cwd_git = CASE WHEN @cwd IS NOT NULL AND (cwd IS NULL OR context_copied & 1) THEN @cwdGit
                        WHEN cwd IS NULL AND @copiedCwd IS NOT NULL THEN @copiedCwdGit
                        WHEN context_copied & 1 AND @copiedCwd = cwd THEN max(cwd_git, @copiedCwdGit)
                        ELSE max(cwd_git, @cwdGit) END,
         context_copied =
           (CASE WHEN @cwd IS NOT NULL AND (cwd IS NULL OR context_copied & 1) THEN 0
                 WHEN cwd IS NULL AND @copiedCwd IS NOT NULL THEN 1 ELSE context_copied & 1 END) |
           (CASE WHEN @branch IS NOT NULL AND (git_branch IS NULL OR context_copied & 2) THEN 0
                 WHEN git_branch IS NULL AND @copiedBranch IS NOT NULL THEN 2 ELSE context_copied & 2 END) |
           (CASE WHEN @gitRemote IS NOT NULL AND (git_remote IS NULL OR context_copied & 4) THEN 0
                 WHEN git_remote IS NULL AND @copiedGitRemote IS NOT NULL THEN 4 ELSE context_copied & 4 END),
         -- A session keeps the host it was first indexed from; only an unknown one is filled.
         host = CASE WHEN host = '' THEN @host ELSE host END,
         first_prompt = coalesce(first_prompt, @firstPrompt),
         title = coalesce(@customTitle, title, @aiTitle),
         index_rev = index_rev + 1
       WHERE sid = @sid`),
        upsertFile: db.prepare(`INSERT INTO files(path, session_sid, size, mtime, ino, head, offset, tail_rowid, tail_msg_id, pending_tools, indexed_at)
       VALUES (@path, @sid, @size, @mtime, @ino, @head, @offset, @tailRowid, @tailMsgId, @pendingTools, @now)
       ON CONFLICT(path) DO UPDATE SET session_sid = excluded.session_sid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, head = excluded.head, offset = excluded.offset,
         tail_rowid = excluded.tail_rowid, tail_msg_id = excluded.tail_msg_id,
         pending_tools = excluded.pending_tools, indexed_at = excluded.indexed_at`),
        touchFile: db.prepare("UPDATE files SET size = ?, mtime = ? WHERE path = ?"),
        deleteMessages: db.prepare("DELETE FROM messages WHERE session_sid = ?"),
        resetSession: db.prepare(`UPDATE sessions SET start_time = NULL, end_time = NULL, message_count = 0, first_prompt = NULL, legacy = 0,
         index_rev = index_rev + 1
       WHERE sid = ?`),
        repoIdent: db.prepare("SELECT host, cwd, git_remote, cwd_git, repo FROM sessions WHERE sid = ?"),
        gitCwdSeen: db.prepare("SELECT 1 FROM sessions WHERE host = ? AND cwd = ? AND sid != ? AND cwd_git = 1 LIMIT 1"),
        flagNewDir: db.prepare("INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
        setRepo: db.prepare("UPDATE sessions SET repo = ?, repo_root = ? WHERE sid = ?"),
        resolveRepo: repoResolver(db),
        implicitKey: implicitRepoKey(db),
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
function ensureSession(db, s, file, host) {
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
            host,
        });
    }).immediate();
    return s.session.get(file.sessionId);
}
/** Paths already reported as skipped, so a sweep logs each once per process. */
const loggedClaimed = new Set();
export function indexFile(db, file, options = {}) {
    const s = statements(db);
    const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
    const host = options.host ?? CONFIG.host;
    const result = {
        status: "unchanged", reset: false, messagesAdded: 0, bytesRead: 0, complete: true, duplicates: noDuplicates(),
    };
    let fd;
    try {
        fd = openSync(file.path, "r");
    }
    catch {
        return { ...result, status: "missing" };
    }
    try {
        const format = formatOf(file.format);
        if (format.firstFileWins && !s.file.get(file.path) && s.otherFile.get(file.sessionId, file.path)) {
            if (!loggedClaimed.has(file.path)) {
                loggedClaimed.add(file.path);
                console.error(`claude-history: skipping ${file.path}: session ${file.sessionId} is already indexed from another file`);
            }
            return result;
        }
        let session = ensureSession(db, s, file, host);
        result.sessionSid = session.sid;
        let row = s.file.get(file.path);
        const keyed = format.uuidLines === true;
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
                // Its lines go with its messages, and every other file of the session is read again.
                s.deleteUuids.run(session.sid);
                s.deleteCutoff.run(session.sid);
                s.rereadOtherFiles.run(session.sid, file.path);
                s.upsertFile.run({
                    path: file.path, sid: session.sid, size: 0, mtime: 0, ino: file.ino, head: "", offset: 0,
                    tailRowid: null, tailMsgId: null, pendingTools: "", now: Date.now(),
                });
                return true;
            }).immediate();
            if (!ok)
                return { ...result, status: "raced" };
            result.reset = true;
        }
        const snap = db.transaction(() => {
            const sessionNow = s.session.get(file.sessionId);
            const own = s.file.get(file.path);
            const state = own ?? (keyed ? s.latestOtherFile.get(sessionNow.sid, file.path) : undefined);
            return {
                session: sessionNow, row: own, state,
                tail: state?.tail_rowid ? s.tailRow.get(state.tail_rowid) : undefined,
                maxSeq: s.maxSeq.get(sessionNow.sid).seq,
                cutoff: keyed ? (s.cutoff.get(sessionNow.sid) ?? null) : null,
                otherOffset: keyed ? (s.otherOffset.get(sessionNow.sid, file.path) ?? 0) : 0,
            };
        })();
        session = snap.session;
        row = snap.row;
        let rev = session.index_rev;
        let offset = row?.offset ?? 0;
        if (row && !result.reset && offset >= file.size) {
            if (row.size !== file.size || row.mtime !== file.mtimeMs)
                s.touchFile.run(file.size, file.mtimeMs, file.path);
            return result;
        }
        // Reopen the row the session's stream last wrote, so its turn can keep growing.
        let pending = null;
        if (snap.tail && snap.state) {
            const tail = snap.tail;
            pending = {
                rowid: tail.id, seq: tail.seq, role: tail.role, ts: tail.ts, msgId: snap.state.tail_msg_id, prose: tail.prose,
                toolInput: tail.tool_input, toolOutput: tail.tool_output, tools: tail.tools ? tail.tools.split(" ") : [], dirty: false,
            };
        }
        const builder = new RowBuilder(pending, snap.maxSeq === null ? 0 : snap.maxSeq + 1, !!session.first_prompt, parsePendingTools(snap.state?.pending_tools));
        builder.sessionCwd = (session.context_copied & COPIED_CWD) !== 0 ? null : session.cwd;
        const tr = format.translator(file, offset > 0);
        let head = row?.head ?? "";
        // The session's cwd, as far as it is known; a project the path does not carry starts as
        // UNKNOWN_PROJECT and is read from the cwd.
        let sessionCwd = session.cwd;
        let project = format.projectFromContent ? session.project : file.projectDir;
        /** Keys this call took and has not committed yet (hex), and the batch's keys to record. */
        const taken = new Set();
        let newKeys = [];
        const duplicates = noDuplicates();
        /** False when a keyed line is already indexed (counted), else true; a new key is noted. */
        const isNew = (line, at) => {
            const key = lineKey(line);
            if (!key)
                return true;
            const hex = key.toString("hex");
            if (taken.has(hex)) {
                duplicates.sameSession++;
                return false;
            }
            const owner = s.uuidOwner.get(key);
            if (owner !== undefined) {
                if (owner === session.sid) {
                    duplicates.sameSession++;
                }
                else {
                    duplicates.otherSession++;
                    builder.detach();
                    builder.noteCopied(line);
                }
                return false;
            }
            taken.add(hex);
            newKeys.push(key);
            // Upgraded from v2: a line another file of this session has passed, no newer than what
            // was indexed then, is already in its rows (without a uuid). Recorded now, not added.
            if (snap.cutoff !== null && at < snap.otherOffset) {
                const ts = parseTimestamp(line.timestamp);
                if (ts !== null && ts <= snap.cutoff) {
                    duplicates.beforeUpgrade++;
                    return false;
                }
            }
            return true;
        };
        for (;;) {
            const batch = readLines(fd, offset, batchBytes);
            const end = batch.end;
            if (end === offset)
                break;
            batch.lines.forEach((line, i) => {
                if (line.length >= BIG_LINE && !format.isMessageLine(line.subarray(0, 2048).toString("utf8")))
                    return;
                let obj;
                try {
                    obj = JSON.parse(line.toString("utf8"));
                }
                catch {
                    return; // a malformed line is skipped, never retried
                }
                for (const l of tr.translate(obj, batch.starts[i])) {
                    if (!keyed || isNew(l, batch.starts[i]))
                        builder.addLine(l);
                }
            });
            const rows = builder.drain();
            const update = builder.update;
            builder.update = emptyUpdate();
            sessionCwd ??= update.cwd ?? update.copiedCwd;
            if (head.length === 0 || Number(head.slice(0, head.indexOf(":"))) < Math.min(HEAD_BYTES, end)) {
                head = headHash(fd, Math.min(HEAD_BYTES, end));
            }
            options.beforeCommit?.();
            const start = offset;
            // A cwd that encodes to nothing (the filesystem root) resolves nothing.
            const fromCwd = format.projectFromContent && project === UNKNOWN_PROJECT && sessionCwd ? claudeProjectDir(sessionCwd) : "";
            const resolved = fromCwd || project;
            let committed;
            try {
                committed = db.transaction(() => {
                    const current = s.file.get(file.path);
                    if ((current?.offset ?? 0) !== start || (current && current.ino !== file.ino))
                        return false;
                    // Another file of this session (or a reset) moved its stream since this view was read.
                    if (s.rev.get(session.sid) !== rev)
                        return false;
                    // A line another indexer recorded since it was looked up: drop the batch, read again.
                    for (const key of newKeys)
                        if (s.insertUuid.run(key, session.sid).changes === 0)
                            throw RACED;
                    if (resolved !== project)
                        s.setProject.run(resolved, session.sid, UNKNOWN_PROJECT);
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
                    const hasGit = (i) => !!i && i.cwd_git === 1;
                    const before = s.repoIdent.get(session.sid);
                    // A remote's credentials never reach the database.
                    s.updateSession.run({
                        ...update, gitRemote: update.gitRemote ? stripRemoteCredentials(update.gitRemote) : null,
                        copiedGitRemote: update.copiedGitRemote ? stripRemoteCredentials(update.copiedGitRemote) : null,
                        added, host, sid: session.sid,
                    });
                    // Resolve on write: O(1) per file, covering sweep and query-time top-up alike. A session
                    // that cannot resolve stays null until its own file is next read. Every lookup is
                    // scoped by the host stored on the session (the first host wins), not this call's.
                    const ident = s.repoIdent.get(session.sid);
                    // The first git evidence at a directory on a host (a branch or remote on a line at the
                    // cwd) may fold worktree sessions already resolved under it (<dir>/.worktrees/<n>
                    // indexed before <dir> itself): it flags the next sweep's full pass. A session whose
                    // unknown host was just filled brings its evidence to that host for the first time.
                    const newAtCwd = (has) => !!ident.cwd && has(ident) && (!has(before) || before?.cwd !== ident.cwd || before?.host !== ident.host);
                    if (newAtCwd(hasGit) && s.gitCwdSeen.get(ident.host, ident.cwd, session.sid) === undefined) {
                        s.flagNewDir.run(REPO_NEW_DIR_KEY);
                    }
                    // A first remote with git evidence at the cwd is an implicit map row there: when it
                    // changes the key that directory's sessions take (sessions resolved before it took
                    // the path), it flags the full pass too.
                    else if (newAtCwd((i) => hasGit(i) && !!i?.git_remote) &&
                        s.implicitKey(ident.host, ident.cwd, session.sid) !== s.implicitKey(ident.host, ident.cwd)) {
                        s.flagNewDir.run(REPO_NEW_DIR_KEY);
                    }
                    // A session's own cwd or remote replaced one its copied lines gave, or its unknown
                    // host was filled: resolve it again.
                    if (ident.repo !== null && before && ((before.cwd !== null && before.cwd !== ident.cwd) ||
                        (before.git_remote !== null && before.git_remote !== ident.git_remote) || before.host !== ident.host)) {
                        s.setRepo.run(null, null, session.sid);
                        ident.repo = null;
                    }
                    if (ident.repo === null && (ident.cwd || ident.git_remote)) {
                        const repo = s.resolveRepo({ host: ident.host, cwd: ident.cwd, gitRemote: ident.git_remote });
                        if (repo)
                            s.setRepo.run(repo.key, repo.root, session.sid);
                    }
                    const tail = builder.pending;
                    const tailState = {
                        tailRowid: tail?.rowid ?? null, tailMsgId: tail?.msgId ?? null, pendingTools: serializePendingTools(builder.calls),
                    };
                    s.upsertFile.run({
                        // Stopping early records the size reached, so the file still reads as changed.
                        path: file.path, sid: session.sid, size: batch.eof ? file.size : end, mtime: file.mtimeMs, ino: file.ino, head, offset: end,
                        ...tailState, now: Date.now(),
                    });
                    if (keyed)
                        s.shareTail.run({ ...tailState, sid: session.sid, path: file.path });
                    result.messagesAdded += added;
                    return true;
                }).immediate();
            }
            catch (error) {
                if (error !== RACED)
                    throw error;
                committed = false;
            }
            if (!committed)
                return { ...result, duplicates, status: "raced" };
            rev++;
            taken.clear();
            newKeys = [];
            project = resolved;
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
        result.duplicates = duplicates;
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