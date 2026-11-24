/**
 * Full-text search over the history database.
 *
 * Filters run in SQL together with the FTS5 MATCH, before ranking and limiting. Hits
 * are ranked with bm25() (prose weighted above tool input, above tool output), a mild
 * recency boost, a boost for the current project and a small penalty for subagents,
 * then grouped by session: the best hit per session plus how many others it has.
 * All terms are required first; when that finds too few sessions, a looser query (any
 * term, last term as a prefix) fills the rest, ranked by how much of the query matched.
 *
 * Session filters (project, branch, source, session, and a date range as a superset)
 * and role run inside the MATCH when they narrow the search to few sessions: the FTS
 * index's weight-0 `scope` column holds "s<session sid> r<role>" for every message, so
 * FTS never returns rows the filters would drop. A loose query on a common prefix can
 * match tens of thousands of messages; filtering those after the MATCH meant reading
 * every one of them.
 */
import type { DB } from "../db/database.js";
import { type ParsedQuery } from "./query-processor.js";
export type SortOrder = "relevance" | "recent";
export interface SearchOptions {
    limit?: number;
    /** Extra project filter (same as project: in the query). */
    project?: string;
    /** Encoded project dir of the caller, boosted in ranking. */
    currentProject?: string;
    includeContext?: boolean;
    sort?: SortOrder;
}
export interface ContextMessage {
    seq: number;
    role: string;
    ts: number | null;
    text: string;
}
export interface SearchHit {
    messageId: number;
    sessionId: string;
    seq: number;
    role: string;
    ts: number | null;
    tools: string[];
    project: string;
    cwd: string | null;
    branch: string | null;
    source: string;
    isSubagent: boolean;
    parentSession: string | null;
    legacy: boolean;
    title: string | null;
    /** Machine the session came from; "" when unknown. */
    host: string;
    /** Text around the matched words, matches wrapped in ** **. */
    snippet: string;
    /** Where the snippet came from. */
    field: "prose" | "tool_input" | "tool_output";
    /** Other matching messages in the same session. */
    otherHits: number;
    /** True when the hit matched only part of the query (loose fallback). */
    partial: boolean;
    score: number;
    before?: ContextMessage;
    after?: ContextMessage;
}
export interface SearchResponse {
    query: ParsedQuery;
    hits: SearchHit[];
    /** Matching messages considered (capped at CONFIG.search.candidateCap per pass). */
    candidates: number;
    capped: boolean;
    empty: boolean;
    /** True when sessions from more than one host exist, so result lines name theirs. */
    showHost: boolean;
}
export declare class SearchEngine {
    private db;
    constructor(db: DB);
    /** Set per search() call: the repositories its project filter reaches, computed once. */
    private repoMemo;
    /** The repositories a project filter reaches (see reposForProjectFilter). */
    private projectRepos;
    /**
     * The filters that can run inside the MATCH, as scope expressions. `none` when the
     * session filters match no session at all.
     */
    private scopeFilters;
    private candidates;
    /**
     * Fraction of the query's groups each candidate matches. One rowid-only scan per group
     * over the candidates' rowid range: asking FTS5 about each candidate rowid in turn
     * re-evaluates the whole expression (prefix terms included) once per rowid.
     */
    private measureCoverage;
    private group;
    private snippets;
    private contextMessage;
    private hydrate;
    search(rawQuery: string, options?: SearchOptions): SearchResponse;
}
//# sourceMappingURL=search-engine.d.ts.map