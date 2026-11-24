/**
 *   <codex sessions>/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl   one Codex CLI session
 *
 * Every line is {timestamp, type, payload} (newer files add a top-level `ordinal`). Only
 * `response_item`, `session_meta` and `turn_context` are read: response_item is the one
 * family present and stable across the whole history, and every `event_msg` repeats it
 * for the UI, so reading both would index each message twice. Records are translated to
 * the Claude line shape RowBuilder reads (see the table in translate()).
 *
 * Shapes confirmed by a keys-only survey of real rollout files (2025-12 to 2026-10):
 *
 *   exec_command   function_call, arguments JSON {cmd: string, workdir?, yield_time_ms?, ...}
 *   shell_command  function_call, arguments JSON {command: string, workdir?, timeout_ms?, ...}
 *   shell          legacy; {command: string[]} (argv), often ["bash", "-lc", "<script>"]
 *   exec           custom_tool_call, input is one string: the JavaScript of a code cell that
 *                  calls the other tools. Since 2026-07 Codex runs shell only this way. The
 *                  source is never parsed as shell (a cell is JavaScript, not shell). Cells
 *                  are very regular, so shell calls are extracted deliberately (js-cell.ts):
 *                  71% call tools.exec_command({...}); 98.6% of those pass `cmd` as a plain
 *                  string literal (other tools.* seen: apply_patch, write_stdin, view_image,
 *                  web__run, clock__curr_time, update_plan); 90% make exactly one call; keys
 *                  seen: cmd, workdir, max_output_tokens, yield_time_ms, sandbox_permissions,
 *                  justification, prefix_rule. Extracted: a call whose argument is an object
 *                  literal with `cmd` (and `workdir`, if present) a quoted string or a
 *                  backtick template without `${`, escapes decoded. Not extracted, never
 *                  guessed: identifiers, shorthand, spread, concatenation, interpolation,
 *                  undecodable escapes, a non-literal workdir, duplicate keys, and anything
 *                  inside comments, strings or regex literals. The scan fails closed: when it
 *                  cannot be sure it read the cell (any division or regex literal, odd comment forms, an
 *                  unusual use of `tools`; the full list is in js-cell.ts) the cell is emitted as a
 *                  plain `exec`. Accepted residual: a literal call in a function body or
 *                  branch that never ran is still extracted.
 *                  A cell whose only tools.* call is one extractable exec_command becomes one
 *                  Bash call (id = the cell's call_id, cwd = its workdir); its output pairs
 *                  with it. Any other cell stays an `exec` call ({input: <source>}) plus one
 *                  Bash call per extractable exec_command (ids <call_id>#1, #2, ...) that has
 *                  no result of its own; the cell's output pairs with `exec`.
 *   apply_patch    custom_tool_call, input is the patch text; kept under its own name
 *   write_stdin, update_plan, wait_agent, spawn_agent ...: kept under their own names
 *
 *   An output is a string, or an array of {type: input_text|input_image, text?} blocks
 *   (images are dropped). A failure shows as one of:
 *     - "Exit code: N" first line (shell_command, apply_patch);
 *     - "Process exited with code N" in the header before "Output:" (exec_command, write_stdin);
 *     - a JSON string {output, metadata: {exit_code, duration_seconds}} (apply_patch, exec);
 *     - a first line "Script failed" (exec).
 *   A header that says the process is still running ("Process running with session ID")
 *   is not an error.
 *
 * Injected context in user messages: see INJECTED_USER_PREFIXES.
 *
 * A guardian_review thread (an automatic approval reviewer, not work) is indexed as a
 * session with no messages: its translator emits nothing. Listing cannot tell it from
 * other files without opening each one on every sweep, and the indexer's files table does
 * not know the file until it is indexed once, so the check lives in the translator, which
 * reads the file's first line only on a resumed read.
 *
 * `agent_message` response items (2026-07 onward) are inter-agent traffic and are skipped:
 * in every surveyed file the assistant's own text is also a `message` record.
 */
import { basename, join } from "path";
import { CONFIG } from "../config.js";
import { UNKNOWN_PROJECT } from "../utils/path-encoder.js";
import { readDir, readFirstLine, statFile } from "./fs-util.js";
import { scanCell } from "./js-cell.js";
/**
 * Start of a user message that Codex or a hook injected, not something the user typed.
 * Found in real files, plus the older wrapper names Codex has used.
 */
export const INJECTED_USER_PREFIXES = [
    "<environment_context>",
    "<user_instructions>",
    "<turn_aborted>",
    "# AGENTS.md instructions",
    "<recommended_plugins>",
    "<subagent_notification>",
    "<user_action>",
    "<no retained transcript delta entries>",
];
const SHELL_TOOLS = new Set(["exec_command", "shell_command", "shell"]);
let runCounter = 0;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function sessionIdOf(fileName) {
    const stem = basename(fileName, ".jsonl");
    const match = stem.match(new RegExp(`(${UUID.source})$`, "i"));
    return `codex-${match ? match[1] : stem}`;
}
function isGuardianMeta(payload) {
    return !!payload && typeof payload === "object" && payload.thread_source === "guardian_review";
}
/** The first line's session_meta payload, or null (missing, over the cap, or not a session_meta). */
function readFirstMeta(path) {
    const line = readFirstLine(path);
    if (!line)
        return null;
    try {
        const first = JSON.parse(line);
        return first.type === "session_meta" ? asRecord(first.payload) : null;
    }
    catch {
        return null;
    }
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
/** A command string for a shell call's arguments, or null when none is present. */
function shellCommand(args) {
    const command = args.cmd ?? args.command;
    if (typeof command === "string")
        return command;
    if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
        const argv = command;
        const shell = argv[0] ? basename(argv[0]) : "";
        if (argv.length >= 3 && ["bash", "sh", "zsh"].includes(shell) && (argv[1] === "-lc" || argv[1] === "-c"))
            return argv[2];
        return argv.join(" ");
    }
    return null;
}
/** Text of a tool output: a string, or the text blocks of an array. */
function outputText(output) {
    if (typeof output === "string")
        return output;
    if (Array.isArray(output)) {
        return output
            .map((b) => (asRecord(b) && typeof b.text === "string" ? b.text : ""))
            .filter(Boolean)
            .join("\n");
    }
    return output === undefined || output === null ? "" : JSON.stringify(output);
}
/** True when the output's header or JSON envelope reports a non-zero exit or a failed script. */
export function outputIsError(text) {
    if (text.startsWith("{") && text.length < (1 << 20)) {
        try {
            const code = asRecord(asRecord(JSON.parse(text))?.metadata)?.exit_code;
            if (typeof code === "number")
                return code !== 0;
        }
        catch {
            // not JSON: fall through to the header forms
        }
    }
    const marker = text.indexOf("\nOutput:");
    const header = marker === -1 ? text.slice(0, 600) : text.slice(0, marker);
    if (/^Script failed\b/.test(header))
        return true;
    const code = /^(?:Exit code:|Process exited with code) (-?\d+)/m.exec(header);
    return code !== null && Number(code[1]) !== 0;
}
class RolloutTranslator {
    cwd = null;
    branch = null;
    /** The header's cwd: its git branch describes that directory only. */
    headerCwd = null;
    guardian = false;
    /** Distinguishes this read's turn ids from an earlier read's, so a reopened row is never matched by accident. */
    run = `${Date.now().toString(36)}.${++runCounter}`;
    turn = 0;
    last = "none";
    constructor(file, resumed) {
        // A fresh read sees session_meta through translate(). A resumed one has not, and
        // turn_context comes only at the start of a turn: one bounded read of the first line seeds it.
        if (!resumed)
            return;
        const meta = readFirstMeta(file.path);
        this.guardian = isGuardianMeta(meta);
        if (meta)
            this.applyMeta(meta);
    }
    applyMeta(payload) {
        if (typeof payload.cwd === "string" && payload.cwd)
            this.cwd = this.headerCwd = payload.cwd;
        const git = asRecord(payload.git);
        if (typeof git?.branch === "string" && git.branch)
            this.branch = git.branch;
    }
    /**
     * Line fields. The header's git branch is attached only to a line at the header's cwd: on
     * a line at another directory (a turn_context cwd, an exec workdir) it would describe a
     * directory that may not be on that branch.
     */
    base(obj, cwd = this.cwd) {
        const atHeader = !!cwd && cwd === this.headerCwd;
        return {
            timestamp: obj.timestamp,
            ...(cwd ? { cwd } : {}),
            ...(atHeader && this.branch ? { gitBranch: this.branch } : {}),
        };
    }
    /** An assistant line; a text or call straight after assistant output joins its turn. */
    assistant(obj, block, cwd) {
        if (this.last !== "assistant")
            this.turn++;
        this.last = "assistant";
        return { type: "assistant", ...this.base(obj, cwd ?? this.cwd), message: { id: `${this.run}-${this.turn}`, content: [block] } };
    }
    translate(obj) {
        if (this.guardian)
            return [];
        const payload = asRecord(obj.payload);
        if (!payload)
            return [];
        switch (obj.type) {
            case "session_meta": {
                if (isGuardianMeta(payload))
                    this.guardian = true;
                this.applyMeta(payload);
                return [];
            }
            case "turn_context":
                if (typeof payload.cwd === "string" && payload.cwd)
                    this.cwd = payload.cwd;
                return [];
            case "response_item":
                return this.item(obj, payload);
            default:
                return [];
        }
    }
    item(obj, p) {
        switch (p.type) {
            case "message":
                return this.message(obj, p);
            case "function_call":
            case "custom_tool_call":
                return this.call(obj, p);
            case "function_call_output":
            case "custom_tool_call_output": {
                if (typeof p.call_id !== "string")
                    return [];
                const text = outputText(p.output);
                this.last = "result";
                return [{
                        type: "user", ...this.base(obj),
                        message: { content: [{ type: "tool_result", tool_use_id: p.call_id, content: text, is_error: outputIsError(text) }] },
                    }];
            }
            default:
                return [];
        }
    }
    message(obj, p) {
        if (p.role !== "user" && p.role !== "assistant")
            return []; // developer: instructions, not conversation
        const blocks = Array.isArray(p.content) ? p.content : [];
        const texts = blocks
            .map((b) => asRecord(b))
            .filter((b) => !!b && typeof b.text === "string")
            .map((b) => b.text)
            .filter((t) => t.trim() && (p.role === "assistant" || !INJECTED_USER_PREFIXES.some((prefix) => t.trimStart().startsWith(prefix))));
        if (texts.length === 0)
            return [];
        const block = { type: "text", text: texts.join("\n\n") };
        if (p.role === "assistant")
            return [this.assistant(obj, block)];
        this.last = "user";
        return [{ type: "user", ...this.base(obj), message: { content: [block] } }];
    }
    /**
     * An `exec` code cell. One extractable exec_command and nothing else is that shell call.
     * Otherwise the cell stays an `exec` call and each extractable exec_command is added as a
     * Bash call (ids <call_id>#1, #2, ...) that gets no result of its own.
     */
    cell(obj, callId, source) {
        let scan;
        try {
            scan = scanCell(source);
        }
        catch {
            scan = { uncertain: true, totalToolCalls: 0, execCommands: [] }; // never abort the file over one cell
        }
        if (scan.uncertain)
            scan = { ...scan, execCommands: [] };
        const bash = (id, call) => this.assistant(obj, { type: "tool_use", id, name: "Bash", input: { command: call.cmd } }, call.workdir?.startsWith("/") ? call.workdir : null);
        const found = scan.execCommands.filter((c) => c !== null);
        if (!scan.uncertain && scan.totalToolCalls === 1 && found.length === 1)
            return [bash(callId, found[0])];
        const lines = [this.assistant(obj, { type: "tool_use", id: callId, name: "exec", input: { input: source } })];
        found.forEach((call, i) => lines.push(bash(`${callId}#${i + 1}`, call)));
        return lines;
    }
    call(obj, p) {
        if (typeof p.name !== "string" || typeof p.call_id !== "string")
            return [];
        const custom = p.type === "custom_tool_call";
        const raw = custom ? p.input : p.arguments;
        const parsed = custom ? null : asRecord(safeParse(raw));
        if (custom && p.name === "exec" && typeof raw === "string")
            return this.cell(obj, p.call_id, raw);
        let name = p.name;
        let input = parsed ?? (typeof raw === "string" ? (custom ? { input: raw } : { arguments: raw }) : (asRecord(raw) ?? {}));
        let cwd = null;
        if (SHELL_TOOLS.has(p.name)) {
            const command = parsed ? shellCommand(parsed) : null;
            if (command !== null) {
                name = "Bash";
                input = { command };
                if (typeof parsed?.workdir === "string" && parsed.workdir.startsWith("/"))
                    cwd = parsed.workdir;
            }
        }
        return [this.assistant(obj, { type: "tool_use", id: p.call_id, name, input }, cwd)];
    }
}
function safeParse(text) {
    if (typeof text !== "string")
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function listRollouts(root) {
    const out = [];
    const dirs = (dir, pattern) => readDir(dir).filter((e) => e.isDirectory() && pattern.test(e.name));
    for (const year of dirs(root, /^\d{4}$/)) {
        for (const month of dirs(join(root, year.name), /^\d{2}$/)) {
            for (const day of dirs(join(root, year.name, month.name), /^\d{2}$/)) {
                const dir = join(root, year.name, month.name, day.name);
                for (const entry of readDir(dir)) {
                    if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl"))
                        continue;
                    const file = statFile(join(dir, entry.name), {
                        source: "codex",
                        format: "codex-rollout",
                        projectDir: UNKNOWN_PROJECT,
                        sessionId: sessionIdOf(entry.name),
                        isSubagent: false, // sub-threads are ordinary sessions: a rollout path carries no parent
                    });
                    if (file)
                        out.push(file);
                }
            }
        }
    }
    return out;
}
export const codexRolloutFormat = {
    id: "codex-rollout",
    source: "codex",
    root: () => CONFIG.codexSessionsDir,
    projectFromContent: true,
    firstFileWins: true,
    list: listRollouts,
    // session_meta carries the cwd and git URL, so it is parsed however large its base instructions make it.
    isMessageLine: (head) => head.includes('"type":"response_item"') || head.includes('"type":"turn_context"') || head.includes('"type":"session_meta"'),
    translator: (file, resumed) => new RolloutTranslator(file, resumed),
};
//# sourceMappingURL=codex-rollout.js.map