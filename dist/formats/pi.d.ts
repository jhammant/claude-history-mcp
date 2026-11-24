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
import type { TranscriptFormat } from "./types.js";
export declare const piFormat: TranscriptFormat;
//# sourceMappingURL=pi.d.ts.map