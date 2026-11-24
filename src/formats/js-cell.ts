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

export const MAX_CELL_BYTES = 256 << 10;
const MAX_DEPTH = 64;
const MAX_CALLS = 64;

/**
 * The one switch of the fail-closed rules: when true, `&&`, `||` and the conditional
 * operator `?` in code mark the scan uncertain (they can skip a call that follows them).
 * The other evaluation-skipping operators and the rebinding words are unconditional.
 */
export const UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY = true;

/** Words that can rebind `tools` or run code the scanner cannot see. */
const REBINDING_WORDS = new Set(["eval", "Function", "globalThis", "Reflect", "with"]);

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

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Decode the body of a JS string or template literal (without its quotes); null when unsure. */
export function decodeJsString(body: string, template: boolean): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      if (!template && (c === "\n" || c === "\r")) return null; // not valid in a quoted string
      if (template && c === "\r") {
        if (body[i + 1] === "\n") i++;
        out += "\n"; // a template's raw CRLF and CR are LF
        continue;
      }
      out += c;
      continue;
    }
    const n = body[++i];
    switch (n) {
      case undefined: return null;
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0":
        if (/[0-9]/.test(body[i + 1] ?? "")) return null;
        out += "\0";
        break;
      case "x": {
        const hex = body.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        if (body[i + 1] === "{") {
          const end = body.indexOf("}", i + 2);
          const hex = end === -1 ? "" : body.slice(i + 2, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
          out += String.fromCodePoint(parseInt(hex, 16));
          i = end;
        } else {
          const hex = body.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      case "\r":
        if (body[i + 1] === "\n") i++;
        break; // line continuation
      case "\n":
      case " ":
      case " ":
        break;
      default:
        if (/[1-9]/.test(n)) return null; // legacy octal escape
        out += n; // \\ \" \' \` \$ and identity escapes
    }
  }
  return out;
}

/** A character outside strings and comments that the scanner will not read (see the header). */
function isUnreadable(s: string, pos: number): boolean {
  const c = s[pos];
  return c.charCodeAt(0) > 0x7f || c === "\\" || c === "#" || (c === "-" && s.startsWith("-->", pos)) || (c === "<" && s.startsWith("<!--", pos));
}

/** At a code character: true when an operator starting here may skip what follows it (see the header). */
function skipsEvaluation(s: string, pos: number): boolean {
  const c = s[pos];
  if (c === "?") {
    const n = s[pos + 1];
    if (n === "?") return true; // ?? and ??=
    if (n === "." && !/[0-9]/.test(s[pos + 2] ?? "")) return true; // ?. (`c ?.5 : x` is a conditional)
    return UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY; // the conditional operator
  }
  if ((c === "|" || c === "&") && s[pos + 1] === c) {
    if (s[pos + 2] === "=") return true; // ||= and &&=
    return UNCERTAIN_ON_SHORT_CIRCUIT_AND_TERNARY;
  }
  return false;
}

class Scanner {
  constructor(private readonly s: string) {}
  pos = 0;
  /** Set when the source could not be read with confidence (unterminated, too deep, ambiguous). */
  bad = false;
  private depth = 0;

  skipSpace(): void {
    for (;;) {
      const c = this.s[this.pos];
      if (c !== undefined && /\s/.test(c)) this.pos++;
      else if (c === "/" && this.s[this.pos + 1] === "/") this.skipLineComment();
      else if (c === "/" && this.s[this.pos + 1] === "*") {
        const end = this.s.indexOf("*/", this.pos + 2);
        if (end === -1) this.bad = true; // unterminated comment
        this.pos = end === -1 ? this.s.length : end + 2;
      } else return;
    }
  }

  private skipLineComment(): void {
    const end = this.s.indexOf("\n", this.pos);
    this.pos = end === -1 ? this.s.length : end + 1;
  }

  /** At a quote: the raw body and position past the closing quote, or null if unterminated. */
  readQuoted(): { body: string; template: boolean; hasInterpolation: boolean } | null {
    const q = this.s[this.pos];
    let i = this.pos + 1;
    let hasInterpolation = false;
    for (; i < this.s.length; i++) {
      const c = this.s[i];
      if (c === "\\") i++;
      else if (c === q) break;
      else if (q === "`" && c === "$" && this.s[i + 1] === "{") hasInterpolation = true;
    }
    if (i >= this.s.length) { this.bad = true; return null; }
    const body = this.s.slice(this.pos + 1, i);
    this.pos = i + 1;
    return { body, template: q === "`", hasInterpolation };
  }

  /** Skip a template literal that may hold `${ ... }` with nested code and strings. */
  skipTemplate(): boolean {
    if (++this.depth > MAX_DEPTH) { this.bad = true; return false; }
    this.pos++; // opening backtick
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === "\\") this.pos += 2;
      else if (c === "`") { this.pos++; this.depth--; return true; }
      else if (c === "$" && this.s[this.pos + 1] === "{") {
        this.pos += 2;
        if (!this.skipBraces()) return false;
      } else this.pos++;
    }
    this.bad = true;
    return false;
  }

  /** Inside `{`: skip code up to its matching `}` (consumed). A `tools` in it makes the scan uncertain. */
  skipBraces(): boolean {
    if (++this.depth > MAX_DEPTH) { this.bad = true; return false; }
    const start = this.pos;
    let depth = 1;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === "'" || c === '"') { if (!this.readQuoted()) return false; }
      else if (c === "`") { if (!this.skipTemplate()) return false; }
      else if (c === "/" && (this.s[this.pos + 1] === "/" || this.s[this.pos + 1] === "*")) this.skipSpace();
      else if (c === "/") { this.bad = true; return false; } // regex or division: not read
      else if (isUnreadable(this.s, this.pos) || skipsEvaluation(this.s, this.pos)) { this.bad = true; return false; }
      else if (IDENT_START.test(c)) {
        const wordStart = this.pos;
        while (this.pos < this.s.length && IDENT_PART.test(this.s[this.pos])) this.pos++;
        if (REBINDING_WORDS.has(this.s.slice(wordStart, this.pos))) { this.bad = true; return false; }
      }
      else if (c === "{") { depth++; this.pos++; }
      else if (c === "}") {
        this.pos++;
        if (--depth === 0) {
          this.depth--;
          if (/\btools\b/.test(this.s.slice(start, this.pos))) this.bad = true;
          return true;
        }
      } else this.pos++;
    }
    this.bad = true;
    return false;
  }

  /** Skip an expression up to a top-level `,` or `}` / `)` (not consumed). */
  skipExpression(): boolean {
    let depth = 0;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === "'" || c === '"') { if (!this.readQuoted()) return false; }
      else if (c === "`") { if (!this.skipTemplate()) return false; }
      else if (c === "/" && (this.s[this.pos + 1] === "/" || this.s[this.pos + 1] === "*")) this.skipSpace();
      else if (c === "/") { this.bad = true; return false; } // regex or division: not read
      else if (c === "(" || c === "[" || c === "{") { depth++; this.pos++; }
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return true;
        depth--;
        this.pos++;
      } else if (c === "," && depth === 0) return true;
      else this.pos++;
    }
    this.bad = true;
    return false;
  }

  /** A property key at pos: identifier or quoted string. Returns null if neither. */
  readKey(): string | null | undefined {
    const c = this.s[this.pos];
    if (c === "'" || c === '"') {
      const q = this.readQuoted();
      return q ? decodeJsString(q.body, false) : null;
    }
    if (c !== undefined && IDENT_START.test(c)) {
      const start = this.pos;
      while (this.pos < this.s.length && IDENT_PART.test(this.s[this.pos])) this.pos++;
      return this.s.slice(start, this.pos);
    }
    return undefined;
  }

  /** Parse the object literal argument at pos (just after `(`). Null when not simple string members. */
  parseArgs(): ExecCommandCall | null {
    this.skipSpace();
    if (this.s[this.pos] !== "{") return null;
    this.pos++;
    const values = new Map<string, string | null>();
    for (;;) {
      this.skipSpace();
      if (this.s[this.pos] === "}") { this.pos++; break; }
      const key = this.readKey();
      if (key === undefined || key === null) return null; // spread, computed key, number, ...
      this.skipSpace();
      let value: string | null = null;
      if (this.s[this.pos] === ":") {
        this.pos++;
        this.skipSpace();
        const c = this.s[this.pos];
        if (c === "'" || c === '"' || c === "`") {
          const q = this.readQuoted();
          if (!q) return null;
          value = q.hasInterpolation ? null : decodeJsString(q.body, q.template);
          this.skipSpace();
          const after = this.s[this.pos];
          if (after !== "," && after !== "}") { value = null; if (!this.skipExpression()) return null; } // concatenation etc.
        } else if (!this.skipExpression()) return null;
      } else if (this.s[this.pos] !== "," && this.s[this.pos] !== "}") return null; // shorthand or method
      if (values.has(key)) return null;
      values.set(key, value);
      this.skipSpace();
      if (this.s[this.pos] === ",") this.pos++;
      else if (this.s[this.pos] !== "}") return null;
    }
    this.skipSpace();
    if (this.s[this.pos] !== ")" && this.s[this.pos] !== ",") return null;
    const cmd = values.get("cmd");
    if (typeof cmd !== "string" || !cmd.trim()) return null;
    if (values.has("workdir") && typeof values.get("workdir") !== "string") return null;
    const workdir = values.get("workdir");
    return { cmd, ...(typeof workdir === "string" ? { workdir } : {}) };
  }
}

export function scanCell(rawSource: string): CellScan {
  const source = rawSource.replace(/\r\n/g, "\n");
  const result: CellScan = { uncertain: false, totalToolCalls: 0, execCommands: [] };
  const uncertain = (): CellScan => ({ uncertain: true, totalToolCalls: 0, execCommands: [] });
  if (source.length > MAX_CELL_BYTES || /[\r\u2028\u2029]/.test(source)) return uncertain();
  const sc = new Scanner(source);
  /** The last significant token before the current one: a word, or a single character. */
  let prev = "";
  while (sc.pos < source.length) {
    const c = source[sc.pos];
    if (c === "'" || c === '"') {
      if (!sc.readQuoted()) return uncertain();
      prev = '"';
    } else if (c === "`") {
      if (!sc.skipTemplate()) return uncertain();
      prev = "`";
    } else if (c === "/" && (source[sc.pos + 1] === "/" || source[sc.pos + 1] === "*")) {
      sc.skipSpace();
    } else if (c === "/") {
      return uncertain(); // division or regex literal: never decided
    } else if (isUnreadable(source, sc.pos) || skipsEvaluation(source, sc.pos)) {
      return uncertain();
    } else if (IDENT_START.test(c)) {
      const start = sc.pos;
      while (sc.pos < source.length && IDENT_PART.test(source[sc.pos])) sc.pos++;
      const word = source.slice(start, sc.pos);
      if (REBINDING_WORDS.has(word)) return uncertain();
      if (word === "tools") {
        // Only an exact, bare `tools.name(` is understood; every other use of `tools` is not.
        if (prev === "." || prev === "new") return uncertain();
        let j = sc.pos;
        if (source[j] !== ".") return uncertain();
        j++;
        const nameStart = j;
        while (j < source.length && IDENT_PART.test(source[j])) j++;
        const name = source.slice(nameStart, j);
        let k = j;
        while (k < source.length && /\s/.test(source[k])) k++;
        if (!name || source[k] !== "(") return uncertain();
        result.totalToolCalls++;
        if (name === "exec_command") {
          const arg = new Scanner(source);
          arg.pos = k + 1;
          const call = arg.parseArgs();
          if (arg.bad) return uncertain();
          result.execCommands.push(call);
          if (result.execCommands.length > MAX_CALLS) return uncertain();
        }
        sc.pos = k + 1; // keep scanning inside the arguments
        prev = "(";
      } else prev = word;
    } else {
      if (!/\s/.test(c)) prev = c;
      sc.pos++;
    }
  }
  if (sc.bad) return uncertain();
  return result;
}
