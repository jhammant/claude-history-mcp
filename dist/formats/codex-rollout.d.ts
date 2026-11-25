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
import type { TranscriptFormat } from "./types.js";
/**
 * Start of a user message that Codex or a hook injected, not something the user typed.
 * Found in real files, plus the older wrapper names Codex has used.
 */
export declare const INJECTED_USER_PREFIXES: readonly string[];
/**
 * Lines written in one fork-time burst are this close together. Measured on real forked
 * rollouts: the largest gap between consecutive replay lines, from line 1, was
 * 32 ms (header to line 1: at most 16 ms); the smallest gap before a fork's first own
 * message or call 666 ms.
 */
export declare const REPLAY_BURST_GAP_MS = 250;
/** True when the output's header or JSON envelope reports a non-zero exit or a failed script. */
export declare function outputIsError(text: string): boolean;
export declare const codexRolloutFormat: TranscriptFormat;
//# sourceMappingURL=codex-rollout.d.ts.map