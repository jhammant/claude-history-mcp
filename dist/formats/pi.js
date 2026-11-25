/**
 *   <pi sessions>/<encoded-cwd>/<timestamp>_<uuid>.jsonl   one pi coding-agent session
 *
 * Every line has {type, id, parentId, timestamp}. The first is {type: "session", version,
 * id, timestamp, cwd}. A session is a tree (parentId); every record is indexed in file
 * order, with no branch reconstruction. Records are translated to the Claude line shape
 * RowBuilder reads:
 *
 *   session                 sets the cwd (and so the project)
 *   message role user       user text line
 *   message role assistant  one assistant line: `text` blocks, and each `toolCall`
 *                           {id, name, arguments} as tool_use {id, name, input}; `thinking` is dropped
 *   message role toolResult user line with tool_result {tool_use_id: toolCallId, is_error: isError}
 *   message role bashExecution  a user-run shell command: {command, output, exitCode, cancelled,
 *                           truncated}; becomes a Bash tool_use plus its tool_result under a synthetic id
 *   message role system, custom_message, model_change, thinking_level_change, compaction,
 *   session_info, context_edit   not conversation: nothing
 *
 * Shapes confirmed by a keys-only survey of real session files: pi's shell tool is named
 * `bash` with arguments {command: string, timeout?: number}; it is the only tool that runs
 * a command string (the others are read, write, edit, web_search, web_fetch) and is emitted
 * as `Bash` with {command}. The rest keep their own names and arguments.
 *
 * bashExecution records are indexed even when `excludeFromContext` is true: that flag only keeps
 * a command out of the model's context, and this is a history index where user-run commands
 * should still be searchable.
 *
 * A resumed read has not seen the session line, so the translator reads the file's first
 * line once, and only when resumed, to recover the cwd.
 */
import { basename, join } from "path";
import { CONFIG } from "../config.js";
import { UNKNOWN_PROJECT } from "../utils/path-encoder.js";
import { readDir, readFirstLine, statFile } from "./fs-util.js";
const SHELL_TOOLS = new Set(["bash"]);
let runCounter = 0;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function sessionIdOf(fileName) {
    const stem = basename(fileName, ".jsonl");
    const match = stem.match(new RegExp(`(${UUID.source})$`, "i"));
    return `pi-${match ? match[1] : stem.slice(stem.lastIndexOf("_") + 1)}`;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
/** The text blocks of a message's content (a string, or blocks), joined. */
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((b) => asRecord(b))
        .filter((b) => !!b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
}
function readCwd(path) {
    const line = readFirstLine(path);
    if (!line)
        return null;
    try {
        const first = asRecord(JSON.parse(line));
        return first?.type === "session" && typeof first.cwd === "string" && first.cwd ? first.cwd : null;
    }
    catch {
        return null;
    }
}
class PiTranslator {
    cwd = null;
    anonymous = 0;
    /** Distinguishes fallback ids of this read from an earlier read's. */
    run = `${Date.now().toString(36)}.${++runCounter}`;
    constructor(file, resumed) {
        if (resumed)
            this.cwd = readCwd(file.path);
    }
    base(obj) {
        return { timestamp: obj.timestamp, ...(this.cwd ? { cwd: this.cwd } : {}) };
    }
    id(obj) {
        return typeof obj.id === "string" && obj.id ? obj.id : `anon-${this.run}-${++this.anonymous}`;
    }
    translate(obj) {
        if (obj.type === "session") {
            if (typeof obj.cwd === "string" && obj.cwd)
                this.cwd = obj.cwd;
            return [];
        }
        if (obj.type !== "message")
            return [];
        const m = asRecord(obj.message);
        if (!m)
            return [];
        switch (m.role) {
            case "user": {
                const text = textOf(m.content);
                return text.trim() ? [{ type: "user", ...this.base(obj), message: { content: [{ type: "text", text }] } }] : [];
            }
            case "assistant":
                return this.assistant(obj, m);
            case "toolResult": {
                if (typeof m.toolCallId !== "string")
                    return [];
                return [this.result(obj, m.toolCallId, textOf(m.content), m.isError === true)];
            }
            case "bashExecution":
                return this.bashExecution(obj, m);
            default:
                return [];
        }
    }
    result(obj, id, content, isError) {
        return { type: "user", ...this.base(obj), message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } };
    }
    assistant(obj, m) {
        const blocks = [];
        for (const raw of Array.isArray(m.content) ? m.content : []) {
            const b = asRecord(raw);
            if (!b)
                continue;
            if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
                blocks.push({ type: "text", text: b.text });
            }
            else if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
                const args = asRecord(b.arguments) ?? {};
                if (SHELL_TOOLS.has(b.name) && typeof args.command === "string") {
                    blocks.push({ type: "tool_use", id: b.id, name: "Bash", input: { command: args.command } });
                }
                else {
                    blocks.push({ type: "tool_use", id: b.id, name: b.name, input: args });
                }
            }
        }
        if (blocks.length === 0)
            return [];
        return [{ type: "assistant", ...this.base(obj), message: { id: this.id(obj), content: blocks } }];
    }
    bashExecution(obj, m) {
        if (typeof m.command !== "string")
            return [];
        const id = `pi-bash-${this.id(obj)}`;
        const failed = m.cancelled === true || (typeof m.exitCode === "number" && m.exitCode !== 0);
        return [
            {
                type: "assistant", ...this.base(obj),
                message: { id, content: [{ type: "tool_use", id, name: "Bash", input: { command: m.command } }] },
            },
            this.result(obj, id, typeof m.output === "string" ? m.output : "", failed),
        ];
    }
}
function listSessions(root) {
    const out = [];
    for (const dir of readDir(root)) {
        if (!dir.isDirectory())
            continue;
        for (const entry of readDir(join(root, dir.name))) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl"))
                continue;
            const file = statFile(join(root, dir.name, entry.name), {
                source: "pi",
                format: "pi",
                projectDir: UNKNOWN_PROJECT,
                sessionId: sessionIdOf(entry.name),
                isSubagent: false,
            });
            if (file)
                out.push(file);
        }
    }
    return out;
}
export const piFormat = {
    id: "pi",
    source: "pi",
    root: () => CONFIG.piSessionsDir,
    projectFromContent: true,
    list: listSessions,
    // The session line is five short fields and never reaches the big-line check.
    isMessageLine: (head) => head.includes('"type":"message"'),
    translator: (file, resumed) => new PiTranslator(file, resumed),
};
//# sourceMappingURL=pi.js.map