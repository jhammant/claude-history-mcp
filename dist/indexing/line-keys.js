/**
 * Claude transcript lines by uuid: the key each line is indexed under at most once, and the
 * order files are indexed in so that the session that started first keeps shared lines.
 *
 * Keyed lines: `type` "user" or "assistant", not `isMeta`, with a `message` object and a
 * non-empty string `uuid`. These are every line RowBuilder.addLine can turn into a message
 * row or merge into one (prompts, assistant blocks, tool results); other line types (system,
 * attachment, summary, titles) make no rows and are read as before.
 */
import { closeSync, openSync, readSync } from "fs";
import { createHash } from "crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 16 bytes: the uuid itself, or for a string that is not one, its sha256 cut to 16 bytes. */
export function uuidKey(uuid) {
    return UUID.test(uuid) ? Buffer.from(uuid.replace(/-/g, ""), "hex") : createHash("sha256").update(uuid).digest().subarray(0, 16);
}
/** The key of a Claude-shaped line, or null when the line is not keyed. */
export function lineKey(line) {
    if (line.type !== "user" && line.type !== "assistant")
        return null;
    if (line.isMeta === true || typeof line.message !== "object" || line.message === null)
        return null;
    return typeof line.uuid === "string" && line.uuid ? uuidKey(line.uuid) : null;
}
const HEAD_CHUNK = 1 << 20;
const HEAD_MAX = 16 << 20;
/** How a Claude file starts, read from its first lines (at most 16 MB). */
export function fileStart(path) {
    const start = { first: Infinity, keyed: Infinity, key: null };
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch {
        return start;
    }
    try {
        let carry = "";
        for (let at = 0; at < HEAD_MAX; at += HEAD_CHUNK) {
            const buffer = Buffer.alloc(HEAD_CHUNK);
            const read = readSync(fd, buffer, 0, HEAD_CHUNK, at);
            if (read <= 0)
                break;
            const lines = (carry + buffer.subarray(0, read).toString("utf8")).split("\n");
            carry = lines.pop() ?? "";
            for (const text of lines) {
                if (!text.includes('"timestamp"'))
                    continue;
                let obj;
                try {
                    obj = JSON.parse(text);
                }
                catch {
                    continue; // a malformed line: keep looking
                }
                const ms = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
                if (Number.isNaN(ms))
                    continue;
                if (start.first === Infinity)
                    start.first = ms;
                const key = lineKey(obj);
                if (key)
                    return { ...start, keyed: ms, key };
            }
            if (read < HEAD_CHUNK)
                break;
        }
        return start;
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Files in the order a sweep indexes them, so that the session that existed first keeps the
 * lines a later one copied. Claude files come first, ordered by:
 *
 *   1. the timestamp of the file's first timestamped line of any type. A fork (Claude Code
 *      copying a session's history into a new session file) writes its leading lines (mode,
 *      attachments, queued prompts) when it is made, after the original started; the original's
 *      leading lines date from its own start.
 *   2. the timestamp of its first keyed line.
 *   3. when `holder` is given (a rebuild: the database being replaced), the file whose session
 *      holds its own first line comes first, so a tie keeps the owner the database had.
 *   4. session id, then path. On a fresh database an exact tie (a fork whose leading lines are
 *      copies too, sibling subagents that share their start) is decided here: arbitrarily.
 *
 * Two copies of one session file tie throughout and are read in path order. Other formats
 * follow in the order given (their own rules apply, e.g. Codex's first file wins).
 */
export function indexingOrder(files, holder) {
    const claude = files.filter((f) => f.format === "claude").map((f) => {
        const s = fileStart(f.path);
        const holds = holder && s.key ? holder(s.key) === f.sessionId : false;
        return { f, s, rank: holds ? 0 : 1 };
    });
    claude.sort((a, b) => byTime(a.s.first, b.s.first) || byTime(a.s.keyed, b.s.keyed) || a.rank - b.rank ||
        cmp(a.f.sessionId, b.f.sessionId) || cmp(a.f.path, b.f.path));
    return [...claude.map((c) => c.f), ...files.filter((f) => f.format !== "claude")];
}
function byTime(a, b) {
    return a === b ? 0 : a < b ? -1 : 1;
}
function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
//# sourceMappingURL=line-keys.js.map