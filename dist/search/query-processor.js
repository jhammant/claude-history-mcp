/**
 * Parse what a user or model types into filters and search terms, and turn the terms
 * into FTS5 MATCH expressions that can never be a syntax error.
 *
 *   project:name  branch:name  tool:Bash  role:user|assistant|tool  source:claude|codex
 *   session:<id or prefix>  before:<date>  after:<date>   (dates: 7d, 2w, 3m, 1y, 2026-01-15)
 *   "an exact phrase"   a OR b   index.msgpack (punctuated terms become phrases)
 */
const FILTER_KEYS = new Set(["project", "before", "after", "tool", "branch", "role", "source", "session"]);
const MAX_GROUPS = 16;
/** Same characters FTS5's unicode61 tokenizer keeps inside a token. */
const TOKEN = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;
export function tokenParts(text) {
    return text.toLowerCase().match(TOKEN) ?? [];
}
export function parseDate(value) {
    const rel = /^(\d+)([hdwmy])$/i.exec(value);
    if (rel) {
        const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000, y: 31_536_000_000 };
        return Date.now() - Number(rel[1]) * unit[rel[2].toLowerCase()];
    }
    if (value === "today") {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }
    if (value === "yesterday") {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime() - 86_400_000;
    }
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? undefined : ts;
}
/** Split into words, quoted phrases and OR; pull out filter directives. */
function lex(raw, filters) {
    const lexemes = [];
    const text = [];
    let i = 0;
    while (i < raw.length) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '"') {
            const close = raw.indexOf('"', i + 1);
            const end = close === -1 ? raw.length : close;
            const value = raw.slice(i + 1, end);
            lexemes.push({ kind: "phrase", value });
            text.push(`"${value}"`);
            i = end + 1;
            continue;
        }
        let j = i;
        while (j < raw.length && !/\s/.test(raw[j])) {
            // key:"quoted value" keeps its spaces
            if (raw[j] === '"' && j > i && raw[j - 1] === ":") {
                const close = raw.indexOf('"', j + 1);
                j = close === -1 ? raw.length : close + 1;
                break;
            }
            j++;
        }
        const word = raw.slice(i, j);
        i = j;
        const colon = word.indexOf(":");
        const key = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
        if (FILTER_KEYS.has(key)) {
            const value = word.slice(colon + 1).replace(/^"|"$/g, "");
            if (value && applyFilter(filters, key, value))
                continue;
        }
        if (word === "OR") {
            lexemes.push({ kind: "or", value: word });
            text.push(word);
            continue;
        }
        if (word === "AND")
            continue; // AND is what terms do anyway
        lexemes.push({ kind: "word", value: word });
        text.push(word);
    }
    return { lexemes, text };
}
function applyFilter(filters, key, value) {
    switch (key) {
        case "project":
        case "tool":
        case "branch":
        case "session":
            filters[key] = value;
            return true;
        case "before":
        case "after": {
            const ts = parseDate(value);
            if (ts === undefined)
                return false;
            filters[key] = ts;
            return true;
        }
        case "role": {
            const role = value.toLowerCase();
            if (role !== "user" && role !== "assistant" && role !== "tool")
                return false;
            filters.role = role;
            return true;
        }
        case "source": {
            const source = value.toLowerCase();
            if (source !== "claude" && source !== "codex")
                return false;
            filters.source = source;
            return true;
        }
    }
    return false;
}
export function parseQuery(rawQuery) {
    const filters = {};
    const { lexemes, text } = lex(rawQuery ?? "", filters);
    const groups = [];
    let joinNext = false;
    for (const lexeme of lexemes) {
        if (lexeme.kind === "or") {
            joinNext = groups.length > 0;
            continue;
        }
        const parts = tokenParts(lexeme.value);
        if (parts.length === 0)
            continue; // pure punctuation
        const term = { parts };
        if (joinNext)
            groups[groups.length - 1].push(term);
        else
            groups.push([term]);
        joinNext = false;
    }
    return {
        text: text.join(" "),
        groups: groups.slice(0, MAX_GROUPS),
        filters,
    };
}
/** A term as FTS5 syntax: every part double-quoted, so no keyword or symbol is special. */
function termToFts(term, prefix = false) {
    return `"${term.parts.join(" ")}"${prefix ? "*" : ""}`;
}
function groupToFts(group, prefixLast = false) {
    const items = group.map((term, i) => termToFts(term, prefixLast && i === group.length - 1));
    return items.length === 1 ? items[0] : `(${items.join(" OR ")})`;
}
/** Every group must match. */
export function strictMatch(query) {
    if (query.groups.length === 0)
        return null;
    return query.groups.map((g) => groupToFts(g)).join(" AND ");
}
/**
 * Each group as its own expression, the last term also matching as a prefix (when it is
 * at least three characters). Joined by OR they are the loose query; one at a time they
 * measure how much of the query a hit covers.
 */
export function looseGroups(query) {
    const last = query.groups.length - 1;
    return query.groups.map((group, gi) => {
        const lastTerm = group[group.length - 1];
        const prefix = gi === last && lastTerm.parts[lastTerm.parts.length - 1].length >= 3;
        return groupToFts(group, prefix);
    });
}
/** Any group may match. */
export function looseMatch(query) {
    const groups = looseGroups(query);
    return groups.length ? groups.join(" OR ") : null;
}
//# sourceMappingURL=query-processor.js.map