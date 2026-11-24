/**
 * A small scanner for the JavaScript cells of Codex's `exec` tool. It finds calls of the
 * form `tools.exec_command({cmd: "...", workdir: "..."})` whose `cmd` (and `workdir`, when
 * present) are plain string literals, and counts every `tools.<name>(` call in the cell.
 *
 * It is not a JavaScript parser. It walks the source once, skipping comments, string and
 * template literals (so text inside them never counts as code), and
 * parses an exec_command argument only when it is an object literal of simple
 * `key: literal` members. Anything else is skipped, never guessed: an identifier, a
 * shorthand property, a spread, a concatenation, a template with `${`, a literal escape
 * it cannot decode, a duplicate key, or a non-literal `workdir`.
 *
 * It fails closed: any of these marks the whole scan `uncertain`, and nothing is extracted:
 *   - a cell over MAX_CELL_BYTES;
 *   - an unterminated string, template, call argument, expression or `/*` comment;
 *   - nesting deeper than MAX_DEPTH, or more than MAX_CALLS exec_command calls;
 *   - any `/` outside strings, templates and comments that does not start `//` or `/*`.
 *     The scanner makes no regex-versus-division decision (every attempt leaked); real
 *     cells hardly ever contain either;
 *   - `<!--` or `-->` anywhere outside strings, templates and comments, and `#!` at the
 *     start of the source (comment forms in sloppy-mode scripts);
 *   - a `\r` (after `\r\n` is read as `\n`), U+2028 or U+2029 anywhere: JavaScript and this
 *     scanner could disagree about where a `//` comment ends;
 *   - outside strings, templates and comments, any character above U+007F, a backslash
 *     or a `#` (unicode identifiers and escapes, private names). Non-ASCII text inside
 *     strings, templates and comments is fine;
 *   - any use of `tools` other than a bare `tools.name(` call: `tools[...]`, `tools?.x`,
 *     whitespace or a comment before `.` or `(`, `tools` as a value, `tools` inside a
 *     `${}` body, `tools` after a `.` (a property of something else) or after `new`;
 *   - outside strings, templates and comments (`${}` bodies included), an operator that can
 *     skip the evaluation of what follows it: `?.`, `??`, `??=`, `||=`, `&&=` always, and
 *     `&&`, `||` and any `?` (the conditional operator) while
 *     UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY is set;
 *   - outside strings, templates and comments, the whole words `eval`, `Function`,
 *     `globalThis`, `Reflect` and `with` (they can rebind `tools` or run code the scanner
 *     cannot see).
 * Accepted residual: a literal call that sits in a function body that is never invoked, or
 * in an `if` / loop body that does not execute, is still extracted.
 */
export declare const MAX_CELL_BYTES: number;
/**
 * The one switch of the fail-closed rules: when true, `&&`, `||` and the conditional
 * operator `?` in code mark the scan uncertain (they can skip a call that follows them).
 * The other evaluation-skipping operators and the rebinding words are unconditional.
 */
export declare const UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY = true;
export interface ExecCommandCall {
    cmd: string;
    workdir?: string;
}
export interface CellScan {
    /** True when the scan could not be sure of its reading: nothing is extracted then. */
    uncertain: boolean;
    /** Every `tools.<name>(` call in code (not in strings or comments). */
    totalToolCalls: number;
    /** One entry per `tools.exec_command(` call, in source order; null when not extractable. */
    execCommands: Array<ExecCommandCall | null>;
}
/** Decode the body of a JS string or template literal (without its quotes); null when unsure. */
export declare function decodeJsString(body: string, template: boolean): string | null;
export declare function scanCell(rawSource: string): CellScan;
//# sourceMappingURL=js-cell.d.ts.map