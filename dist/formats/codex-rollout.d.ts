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
import type { TranscriptFormat } from "./types.js";
/**
 * Start of a user message that Codex or a hook injected, not something the user typed.
 * Found in real files, plus the older wrapper names Codex has used.
 */
export declare const INJECTED_USER_PREFIXES: readonly string[];
/** True when the output's header or JSON envelope reports a non-zero exit or a failed script. */
export declare function outputIsError(text: string): boolean;
export declare const codexRolloutFormat: TranscriptFormat;
//# sourceMappingURL=codex-rollout.d.ts.map