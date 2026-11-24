/**
 *   <codex sessions>/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl   one Codex CLI session
 *
 * Every line is {timestamp, type, payload} (newer files add a top-level `ordinal`). Only
 * `response_item`, `session_meta` and `turn_context` are read: response_item is the one
 * family present and stable across the whole history, and every `event_msg` repeats it
 * for the UI, so reading both would index each message twice. Records are translated to
 * the Claude line shape RowBuilder reads (see the table in translate()).
 *
 * Shapes confirmed by a keys-only survey of real rollout files (Codex CLI 0.66 to 0.170):
 *
 *   exec_command   function_call, arguments JSON {cmd: string, workdir?, yield_time_ms?, ...}
 *   shell_command  function_call, arguments JSON {command: string, workdir?, timeout_ms?, ...}
 *   shell          legacy; {command: string[]} (argv), often ["bash", "-lc", "<script>"]
 *   exec           custom_tool_call, input is one string: the JavaScript of a code cell that
 *                  calls the other tools. Since 2026-07 Codex runs shell only this way. The
 *                  source is never parsed as shell (a cell is JavaScript, not shell). Cells
 *                  are very regular, so shell calls are extracted deliberately (js-cell.ts):
 *                  most call tools.exec_command({...}), nearly always with `cmd` as a plain
 *                  string literal (other tools.* seen: apply_patch, write_stdin, view_image,
 *                  web__run, clock__curr_time, update_plan); most make exactly one call; keys
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
 * reads the file's first line (the header) on a resumed read.
 *
 * Forked rollouts. A fork (a spawned subagent, or a user's fork) starts by writing its
 * parent's history again, in one burst at fork time, then its own lines. That replay is
 * the parent's work, so it is never indexed for the fork. From a structure-only survey of
 * real rollouts (CLI 0.66 to 0.170):
 *   - line 0 is the fork's own session_meta (its id, cwd, git; `forked_from_id`, and
 *     `parent_thread_id` / `source.subagent.thread_spawn` for a subagent); line 1 is
 *     usually the parent's session_meta, replayed. Only a session_meta with the file's own
 *     id is read: the replayed one would overwrite the fork's cwd and git with the parent's.
 *   - `subagent_history_start_ordinal` (history_mode "paginated", plus the
 *     guardian threads) is the top-level `ordinal` of the first line of the fork's own
 *     history: an `event_msg` thread_settings_applied in every one. Every line carries an
 *     ordinal equal to its line index; lines below it are skipped. Checked against each
 *     parent's rollout: no response item from the parent's history at or after it.
 *   - `history_base` (a paginated user fork) names the base thread and the ordinal and byte
 *     offset its history ends at instead of copying it: the file holds only its own lines.
 *   - Older forks (history_mode "legacy" or none, CLI 0.118 to 0.147, and CLI
 *     0.66 files that mark the replay only by the parent's session_meta on line 1) state no
 *     boundary. There the replay is the burst: from line 1 (the header can be stamped
 *     earlier), the lines up to the first gap of more than REPLAY_BURST_GAP_MS between two
 *     stamped lines. The cut is found once per read by scanning the head and kept as a byte
 *     offset, so a full read, a resumed read and a rebuild cut at the same line whatever the
 *     later lines' timestamps. Checked against the parent's rollouts it skips exactly the
 *     parent's history, except in some CLI 0.118 files, where it also skips the
 *     spawn_agent output written in the burst, whose call is the parent's (in the replay).
 *     This timestamp rule is used only for forks that state no boundary and are not
 *     history_mode "paginated" (a paginated fork with neither a start ordinal nor
 *     history_base skips nothing; none was seen).
 *   - A fork's session cwd is its header's (its first own row is often a call at an exec
 *     workdir), and a subagent fork's task, sent as an `agent_message`, is its
 *     first prompt: see spawnTask().
 *
 *   A rollout with neither `forked_from_id` nor another thread's session_meta on line 1 is
 *   read whole, as before.
 *
 * `agent_message` response items (2026-07 onward) are inter-agent traffic and make no row:
 * in every surveyed file the assistant's own text is also a `message` record. The one
 * exception is a fork's first one with text, which seeds its first prompt (spawnTask()).
 *
 * Timing rule limit: a line with no timestamp, or one stamped earlier, just before the first
 * gap is cut with the replay. Every read pattern agrees on this; no real file seen had it.
 */

import { closeSync, openSync } from "fs";
import { basename, join } from "path";
import { CONFIG } from "../config.js";
import { readLines } from "../indexing/line-reader.js";
import type { TranscriptFile } from "../parsers/transcript-files.js";
import { UNKNOWN_PROJECT } from "../utils/path-encoder.js";
import { readDir, readHeadLines, statFile } from "./fs-util.js";
import { scanCell } from "./js-cell.js";
import type { ClaudeLine, LineTranslator, TranscriptFormat } from "./types.js";

/**
 * Start of a user message that Codex or a hook injected, not something the user typed.
 * Found in real files, plus the older wrapper names Codex has used.
 */
export const INJECTED_USER_PREFIXES: readonly string[] = [
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

function sessionIdOf(fileName: string): string {
  const stem = basename(fileName, ".jsonl");
  const match = stem.match(new RegExp(`(${UUID.source})$`, "i"));
  return `codex-${match ? match[1] : stem}`;
}

function isGuardianMeta(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as Record<string, unknown>).thread_source === "guardian_review";
}

function parseMeta(line: string | undefined): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return obj.type === "session_meta" ? asRecord(obj.payload) : null;
  } catch {
    return null;
  }
}

/**
 * Where a forked rollout's own lines begin. See "Forked rollouts" in the header comment.
 *   none     nothing to skip (not a fork, or a fork whose history stays in its base file)
 *   ordinal  skip every line whose `ordinal` is below `start` (the file states it)
 *   burst    skip the lines before byte offset `end`, written in the fork-time burst (old
 *            files that state nothing)
 */
type Replay = { kind: "none" } | { kind: "ordinal"; start: number } | { kind: "burst"; end: number };

/**
 * Lines written in one fork-time burst are this close together. Measured on real forked
 * rollouts: the largest gap between consecutive replay lines, from line 1, was
 * 32 ms (header to line 1: at most 16 ms); the smallest gap before a fork's first own
 * message or call 666 ms.
 */
export const REPLAY_BURST_GAP_MS = 250;

function parseTs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const LEADING_TS = /^\{"timestamp":"([^"]{1,64})"/;
/** A line without a leading timestamp is parsed for one only up to this size. */
const REPLAY_SCAN_LINE_MAX = 1 << 20;

/** A line's timestamp: read from its head when it leads (every rollout line does), else parsed. */
function lineTs(line: Buffer): number | null {
  const lead = LEADING_TS.exec(line.subarray(0, 96).toString("latin1"));
  if (lead) return parseTs(lead[1]);
  if (line.length > REPLAY_SCAN_LINE_MAX) return null;
  try {
    return parseTs((JSON.parse(line.toString("utf8")) as Record<string, unknown>).timestamp);
  } catch {
    return null;
  }
}

/**
 * The byte offset where the fork-time burst that follows the header ends: the start of the
 * first line after a gap of more than REPLAY_BURST_GAP_MS between two stamped lines,
 * counted from line 1 (the header may be stamped well before the replay). A file that ends
 * inside the burst gives the end of its last complete line (a later read scans again, and
 * finds the same offset or a later one). Null when no line after the header has a timestamp.
 */
function burstEnd(path: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    let offset = 0;
    let prev: number | null = null;
    for (;;) {
      const batch = readLines(fd, offset, 1 << 20);
      for (let i = 0; i < batch.lines.length; i++) {
        if (batch.starts[i] === 0) continue; // the header
        const ts = lineTs(batch.lines[i]);
        if (ts === null) continue;
        if (prev !== null && ts - prev > REPLAY_BURST_GAP_MS) return batch.starts[i];
        prev = ts;
      }
      if (batch.eof || batch.end === offset) return prev === null ? null : batch.end;
      offset = batch.end;
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The rollout's header (line 0) and how the file replays history, read from the header and
 * line 1. A header that cannot be read (over the cap) replays nothing.
 */
function readReplay(path: string): { header: Record<string, unknown> | null; replay: Replay } {
  const [first, second] = readHeadLines(path, 2);
  const header = parseMeta(first);
  if (!header) return { header, replay: { kind: "none" } };
  const start = header.subagent_history_start_ordinal;
  if (typeof start === "number" && Number.isInteger(start) && start > 0) return { header, replay: { kind: "ordinal", start } };
  // A paginated file states its boundary (an ordinal, or history_base) or has none to skip.
  if (header.history_base !== undefined && header.history_base !== null) return { header, replay: { kind: "none" } };
  if (header.history_mode === "paginated") return { header, replay: { kind: "none" } };
  const next = parseMeta(second);
  const replayed = typeof header.forked_from_id === "string" || (!!next && next.id !== header.id);
  if (!replayed) return { header, replay: { kind: "none" } };
  const end = burstEnd(path);
  // No timestamp after the header: nothing can be told apart, so nothing is skipped.
  return { header, replay: end === null ? { kind: "none" } : { kind: "burst", end } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A command string for a shell call's arguments, or null when none is present. */
function shellCommand(args: Record<string, unknown>): string | null {
  const command = args.cmd ?? args.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
    const argv = command as string[];
    const shell = argv[0] ? basename(argv[0]) : "";
    if (argv.length >= 3 && ["bash", "sh", "zsh"].includes(shell) && (argv[1] === "-lc" || argv[1] === "-c")) return argv[2];
    return argv.join(" ");
  }
  return null;
}

/** Text of a tool output: a string, or the text blocks of an array. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => (asRecord(b) && typeof (b as Record<string, unknown>).text === "string" ? ((b as Record<string, unknown>).text as string) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

/** True when the output's header or JSON envelope reports a non-zero exit or a failed script. */
export function outputIsError(text: string): boolean {
  if (text.startsWith("{") && text.length < (1 << 20)) {
    try {
      const code = asRecord(asRecord(JSON.parse(text))?.metadata)?.exit_code;
      if (typeof code === "number") return code !== 0;
    } catch {
      // not JSON: fall through to the header forms
    }
  }
  const marker = text.indexOf("\nOutput:");
  const header = marker === -1 ? text.slice(0, 600) : text.slice(0, marker);
  if (/^Script failed\b/.test(header)) return true;
  const code = /^(?:Exit code:|Process exited with code) (-?\d+)/m.exec(header);
  return code !== null && Number(code[1]) !== 0;
}

class RolloutTranslator implements LineTranslator {
  private cwd: string | null = null;
  private branch: string | null = null;
  /** The header's cwd: its git branch describes that directory only. */
  private headerCwd: string | null = null;
  private guardian = false;
  /** Distinguishes this read's turn ids from an earlier read's, so a reopened row is never matched by accident. */
  private readonly run = `${Date.now().toString(36)}.${++runCounter}`;
  private turn = 0;
  private last: "none" | "user" | "assistant" | "result" = "none";
  /** The id of this file's own header; a session_meta with another id is a replayed thread's. */
  private ownId: string | null = null;
  private replay: Replay;
  /** True for a forked rollout: its session cwd is its header's, and a spawn task is its first prompt. */
  private fork = false;
  /** Lines translated so far in this read (a fresh read's first is the header). */
  private seen = 0;
  /** A user message or a spawn task has been read in this read. */
  private prompted = false;
  /** The header's agent_path: a spawn task is addressed to it. */
  private agentPath: string | null = null;

  constructor(file: TranscriptFile, private readonly resumed: boolean) {
    // One bounded read of the head tells whether the file replays another thread's history.
    // A fresh read then sees session_meta through translate(). A resumed one has not, and
    // turn_context comes only at the start of a turn: the header seeds it.
    const { header, replay } = readReplay(file.path);
    this.replay = replay;
    this.fork = replay.kind !== "none" || typeof header?.forked_from_id === "string";
    if (typeof header?.id === "string") this.ownId = header.id;
    if (typeof header?.agent_path === "string") this.agentPath = header.agent_path;
    if (!resumed) return;
    this.guardian = isGuardianMeta(header);
    if (header) this.applyMeta(header);
  }

  /** True for a line of the replayed history at the start of a forked rollout (`at`: its byte offset). */
  private replayed(obj: Record<string, unknown>, at: number | undefined): boolean {
    const r = this.replay;
    // A line without an ordinal in such a file is kept (none was seen).
    if (r.kind === "ordinal") return typeof obj.ordinal === "number" && obj.ordinal < r.start;
    // The burst is a byte range of the file, so every way of reading it cuts at the same line.
    if (r.kind === "burst") return at !== undefined && at < r.end;
    return false;
  }

  private applyMeta(payload: Record<string, unknown>): void {
    if (typeof payload.cwd === "string" && payload.cwd) this.cwd = this.headerCwd = payload.cwd;
    const git = asRecord(payload.git);
    if (typeof git?.branch === "string" && git.branch) this.branch = git.branch;
  }

  /**
   * Line fields. The header's git branch is attached only to a line at the header's cwd: on
   * a line at another directory (a turn_context cwd, an exec workdir) it would describe a
   * directory that may not be on that branch.
   */
  private base(obj: Record<string, unknown>, cwd = this.cwd): ClaudeLine {
    const atHeader = !!cwd && cwd === this.headerCwd;
    return {
      timestamp: obj.timestamp,
      ...(cwd ? { cwd } : {}),
      // A fork's first own line is often a call at an exec workdir: the session's cwd is its header's.
      ...(this.fork && this.headerCwd ? { sessionCwd: this.headerCwd } : {}),
      ...(atHeader && this.branch ? { gitBranch: this.branch } : {}),
    };
  }

  /** An assistant line; a text or call straight after assistant output joins its turn. */
  private assistant(obj: Record<string, unknown>, block: Record<string, unknown>, cwd?: string | null): ClaudeLine {
    if (this.last !== "assistant") this.turn++;
    this.last = "assistant";
    return { type: "assistant", ...this.base(obj, cwd ?? this.cwd), message: { id: `${this.run}-${this.turn}`, content: [block] } };
  }

  translate(obj: Record<string, unknown>, at?: number): ClaudeLine[] {
    const first = this.seen++ === 0 && !this.resumed;
    if (this.guardian) return [];
    const payload = asRecord(obj.payload);
    if (!payload) return [];
    if (obj.type === "session_meta") {
      // Only the file's own header describes this session: the first line of the file, or a
      // session_meta with its id. Another thread's (replayed, with or without an id) never does.
      // A non-fork whose first line is no session_meta takes the first one with an id, as before.
      const id = typeof payload.id === "string" ? payload.id : null;
      if (first || !this.fork) this.ownId ??= id;
      if (!first && (id === null || id !== this.ownId)) return [];
      if (isGuardianMeta(payload)) this.guardian = true;
      this.applyMeta(payload);
      return [];
    }
    if (this.replayed(obj, at)) return [];
    switch (obj.type) {
      case "turn_context":
        if (typeof payload.cwd === "string" && payload.cwd) this.cwd = payload.cwd;
        return [];
      case "response_item":
        return this.item(obj, payload);
      default:
        return [];
    }
  }

  private item(obj: Record<string, unknown>, p: Record<string, unknown>): ClaudeLine[] {
    switch (p.type) {
      case "message":
        return this.message(obj, p);
      case "function_call":
      case "custom_tool_call":
        return this.call(obj, p);
      case "function_call_output":
      case "custom_tool_call_output": {
        if (typeof p.call_id !== "string") return [];
        const text = outputText(p.output);
        this.last = "result";
        return [{
          type: "user", ...this.base(obj),
          message: { content: [{ type: "tool_result", tool_use_id: p.call_id, content: text, is_error: outputIsError(text) }] },
        }];
      }
      case "agent_message":
        return this.spawnTask(p);
      default:
        return [];
    }
  }

  /**
   * A forked subagent gets its task as an `agent_message` (most forks other than a history_base one), so it has
   * no user message to take a first prompt from: the first agent_message of a fork, before
   * any user message in this read, is its first prompt. It makes no row (inter-agent
   * traffic is not indexed); the indexer keeps a first prompt already stored.
   */
  private spawnTask(p: Record<string, unknown>): ClaudeLine[] {
    if (!this.fork || this.prompted) return [];
    // Addressed to this agent (in every real file the recipient is the header's agent_path).
    if (this.agentPath && typeof p.recipient === "string" && p.recipient !== this.agentPath) return [];
    const text = (Array.isArray(p.content) ? p.content : [])
      .map((b) => asRecord(b))
      .filter((b): b is Record<string, unknown> => !!b && b.type === "input_text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .filter((t) => t.trim() && !INJECTED_USER_PREFIXES.some((prefix) => t.trimStart().startsWith(prefix)))
      .join("\n\n");
    // Only a message with text counts, so a resumed read (which forgets `prompted`) agrees
    // with a full read when the first agent_message is empty or injected text only.
    if (!text) return [];
    this.prompted = true;
    return [{ type: "first-prompt", text }];
  }

  private message(obj: Record<string, unknown>, p: Record<string, unknown>): ClaudeLine[] {
    if (p.role !== "user" && p.role !== "assistant") return []; // developer: instructions, not conversation
    const blocks = Array.isArray(p.content) ? p.content : [];
    const texts = blocks
      .map((b) => asRecord(b))
      .filter((b): b is Record<string, unknown> => !!b && typeof b.text === "string")
      .map((b) => b.text as string)
      .filter((t) => t.trim() && (p.role === "assistant" || !INJECTED_USER_PREFIXES.some((prefix) => t.trimStart().startsWith(prefix))));
    if (texts.length === 0) return [];
    const block = { type: "text", text: texts.join("\n\n") };
    if (p.role === "assistant") return [this.assistant(obj, block)];
    this.last = "user";
    this.prompted = true;
    return [{ type: "user", ...this.base(obj), message: { content: [block] } }];
  }

  /**
   * An `exec` code cell. One extractable exec_command and nothing else is that shell call.
   * Otherwise the cell stays an `exec` call and each extractable exec_command is added as a
   * Bash call (ids <call_id>#1, #2, ...) that gets no result of its own.
   */
  private cell(obj: Record<string, unknown>, callId: string, source: string): ClaudeLine[] {
    let scan: ReturnType<typeof scanCell>;
    try {
      scan = scanCell(source);
    } catch {
      scan = { uncertain: true, totalToolCalls: 0, execCommands: [] }; // never abort the file over one cell
    }
    if (scan.uncertain) scan = { ...scan, execCommands: [] };
    const bash = (id: string, call: { cmd: string; workdir?: string }) =>
      this.assistant(obj, { type: "tool_use", id, name: "Bash", input: { command: call.cmd } }, call.workdir?.startsWith("/") ? call.workdir : null);
    const found = scan.execCommands.filter((c): c is { cmd: string; workdir?: string } => c !== null);
    if (!scan.uncertain && scan.totalToolCalls === 1 && found.length === 1) return [bash(callId, found[0])];
    const lines = [this.assistant(obj, { type: "tool_use", id: callId, name: "exec", input: { input: source } })];
    found.forEach((call, i) => lines.push(bash(`${callId}#${i + 1}`, call)));
    return lines;
  }

  private call(obj: Record<string, unknown>, p: Record<string, unknown>): ClaudeLine[] {
    if (typeof p.name !== "string" || typeof p.call_id !== "string") return [];
    const custom = p.type === "custom_tool_call";
    const raw = custom ? p.input : p.arguments;
    const parsed = custom ? null : asRecord(safeParse(raw));
    if (custom && p.name === "exec" && typeof raw === "string") return this.cell(obj, p.call_id, raw);
    let name = p.name;
    let input: Record<string, unknown> = parsed ?? (typeof raw === "string" ? (custom ? { input: raw } : { arguments: raw }) : (asRecord(raw) ?? {}));
    let cwd: string | null = null;
    if (SHELL_TOOLS.has(p.name)) {
      const command = parsed ? shellCommand(parsed) : null;
      if (command !== null) {
        name = "Bash";
        input = { command };
        if (typeof parsed?.workdir === "string" && parsed.workdir.startsWith("/")) cwd = parsed.workdir;
      }
    }
    return [this.assistant(obj, { type: "tool_use", id: p.call_id, name, input }, cwd)];
  }
}

function safeParse(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listRollouts(root: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const dirs = (dir: string, pattern: RegExp) => readDir(dir).filter((e) => e.isDirectory() && pattern.test(e.name));
  for (const year of dirs(root, /^\d{4}$/)) {
    for (const month of dirs(join(root, year.name), /^\d{2}$/)) {
      for (const day of dirs(join(root, year.name, month.name), /^\d{2}$/)) {
        const dir = join(root, year.name, month.name, day.name);
        for (const entry of readDir(dir)) {
          if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
          const file = statFile(join(dir, entry.name), {
            source: "codex",
            format: "codex-rollout",
            projectDir: UNKNOWN_PROJECT,
            sessionId: sessionIdOf(entry.name),
            isSubagent: false, // sub-threads are ordinary sessions: a rollout path carries no parent
          });
          if (file) out.push(file);
        }
      }
    }
  }
  return out;
}

export const codexRolloutFormat: TranscriptFormat = {
  id: "codex-rollout",
  source: "codex",
  root: () => CONFIG.codexSessionsDir,
  projectFromContent: true,
  firstFileWins: true,
  list: listRollouts,
  // session_meta carries the cwd and git branch, so it is parsed however large its base instructions make it.
  isMessageLine: (head) =>
    head.includes('"type":"response_item"') || head.includes('"type":"turn_context"') || head.includes('"type":"session_meta"'),
  translator: (file, resumed) => new RolloutTranslator(file, resumed),
};
