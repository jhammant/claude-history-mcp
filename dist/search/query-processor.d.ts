/**
 * Parse what a user or model types into filters and search terms, and turn the terms
 * into FTS5 MATCH expressions that can never be a syntax error.
 *
 *   project:name  branch:name  tool:Bash  role:user|assistant|tool  source:claude|codex
 *   session:<id or prefix>  before:<date>  after:<date>   (dates: 7d, 2w, 3m, 1y, 2026-01-15)
 *   "an exact phrase"   a OR b   index.msgpack (punctuated terms become phrases)
 */
export type Role = "user" | "assistant" | "tool";
export type Source = "claude" | "codex";
export interface QueryFilters {
    project?: string;
    before?: number;
    after?: number;
    tool?: string;
    branch?: string;
    role?: Role;
    source?: Source;
    session?: string;
}
/** One search term: the token parts FTS5 will see (several parts = a phrase). */
export interface Term {
    parts: string[];
}
/** Terms joined by AND; each group is one term or several alternatives joined by OR. */
export interface ParsedQuery {
    text: string;
    groups: Term[][];
    filters: QueryFilters;
}
export declare function tokenParts(text: string): string[];
export declare function parseDate(value: string): number | undefined;
export declare function parseQuery(rawQuery: string): ParsedQuery;
/** Every group must match. */
export declare function strictMatch(query: ParsedQuery): string | null;
/**
 * Each group as its own expression, the last term also matching as a prefix (when it is
 * at least three characters). Joined by OR they are the loose query; one at a time they
 * measure how much of the query a hit covers.
 */
export declare function looseGroups(query: ParsedQuery): string[];
/** Any group may match. */
export declare function looseMatch(query: ParsedQuery): string | null;
//# sourceMappingURL=query-processor.d.ts.map