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

import { CONFIG } from "../config.js";
import type { DB } from "../db/database.js";
import {
  looseGroups,
  looseMatch,
  parseQuery,
  strictMatch,
  type ParsedQuery,
  type QueryFilters,
} from "./query-processor.js";

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
}

interface Candidate {
  id: number;
  sid: number;
  ts: number | null;
  project: string;
  sub: number;
  bm: number;
  score: number;
  coverage: number;
}

interface Group {
  best: Candidate;
  count: number;
  latest: number;
}

/** Snippet markers that cannot occur in text, swapped for ** on output. */
const OPEN = "\u0001";
const CLOSE = "\u0002";

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Search terms only ever match the text columns, never the scope tokens. */
function inText(expr: string): string {
  return `{prose tool_input tool_output} : (${expr})`;
}

function hasSessionFilter(filters: QueryFilters): boolean {
  return !!(filters.project || filters.branch || filters.source || filters.session) ||
    filters.after !== undefined || filters.before !== undefined;
}

/**
 * Clauses on the session row (alias s). With `dateRange`, also keep only sessions whose
 * time span overlaps the after/before range: a superset of the sessions with a message
 * in range, used to narrow the search before the exact per-message date check.
 */
function sessionClauses(filters: QueryFilters, params: Record<string, unknown>, dateRange: boolean): string[] {
  const clauses: string[] = [];
  if (filters.project) {
    params.project = `%${likeEscape(filters.project)}%`;
    clauses.push("(s.project LIKE @project ESCAPE '\\' OR s.cwd LIKE @project ESCAPE '\\')");
  }
  if (filters.branch) {
    params.branch = `%${likeEscape(filters.branch)}%`;
    clauses.push("s.git_branch LIKE @branch ESCAPE '\\'");
  }
  if (filters.source) {
    params.source = filters.source;
    clauses.push("s.source = @source");
  }
  if (filters.session) {
    params.session = `${likeEscape(filters.session)}%`;
    clauses.push("(s.id LIKE @session ESCAPE '\\' OR s.parent_session LIKE @session ESCAPE '\\')");
  }
  if (dateRange && filters.after !== undefined) {
    params.after = filters.after;
    clauses.push("s.end_time >= @after");
  }
  if (dateRange && filters.before !== undefined) {
    params.before = filters.before;
    clauses.push("s.start_time < @before");
  }
  return clauses;
}

/** Clauses on the message row (alias m). */
function messageClauses(filters: QueryFilters, params: Record<string, unknown>): string[] {
  const clauses: string[] = [];
  if (filters.tool) {
    params.tool = `%${likeEscape(filters.tool)}%`;
    clauses.push("m.tools LIKE @tool ESCAPE '\\'");
  }
  if (filters.role) {
    params.role = filters.role;
    clauses.push("(m.role = @role OR m.role = 'mixed')");
  }
  if (filters.after !== undefined) {
    params.after = filters.after;
    clauses.push("m.ts >= @after");
  }
  if (filters.before !== undefined) {
    params.before = filters.before;
    clauses.push("m.ts < @before");
  }
  return clauses;
}

function boost(c: Omit<Candidate, "score">, currentProject: string | undefined, now: number): number {
  const s = CONFIG.search;
  const ageDays = c.ts ? Math.max(0, (now - c.ts) / 86_400_000) : 365;
  let score = -c.bm * (1 + s.recencyBoost * Math.pow(0.5, ageDays / s.recencyHalfLifeDays));
  if (currentProject && c.project === currentProject) score *= s.currentProjectBoost;
  if (c.sub) score *= s.subagentFactor;
  return score;
}

export class SearchEngine {
  constructor(private db: DB) {}

  /**
   * The filters that can run inside the MATCH, as scope expressions. `none` when the
   * session filters match no session at all.
   */
  private scopeFilters(filters: QueryFilters): { exprs: string[]; none: boolean } {
    const exprs: string[] = [];
    if (hasSessionFilter(filters)) {
      const params: Record<string, unknown> = {};
      const clauses = sessionClauses(filters, params, true);
      const max = CONFIG.search.scopeMaxSessions;
      const sids = this.db
        .prepare(`SELECT sid FROM sessions s WHERE ${clauses.join(" AND ")} LIMIT ${max + 1}`)
        .pluck()
        .all(params) as number[];
      if (sids.length === 0) return { exprs, none: true };
      if (sids.length <= max) exprs.push(`scope : (${sids.map((sid) => `"s${sid}"`).join(" OR ")})`);
    }
    if (filters.role) exprs.push(`scope : ("r${filters.role}" OR "rmixed")`);
    return { exprs, none: false };
  }

  private candidates(match: string | null, filters: QueryFilters, sort: SortOrder, currentProject?: string): Candidate[] {
    const params: Record<string, unknown> = { cap: CONFIG.search.candidateCap };
    const clauses = [...sessionClauses(filters, params, false), ...messageClauses(filters, params)];
    const [wp, wi, wo] = CONFIG.search.weights;
    let sql: string;
    if (match) {
      params.match = match;
      clauses.unshift("messages_fts MATCH @match");
      sql = `SELECT m.id, m.session_sid AS sid, m.ts, s.project, s.is_subagent AS sub,
               bm25(messages_fts, ${wp}, ${wi}, ${wo}, 0) AS bm
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             JOIN sessions s ON s.sid = m.session_sid
             WHERE ${clauses.join(" AND ")}
             ORDER BY ${sort === "recent" ? "m.ts DESC" : "bm"} LIMIT @cap`;
    } else {
      sql = `SELECT m.id, m.session_sid AS sid, m.ts, s.project, s.is_subagent AS sub, -1.0 AS bm
             FROM messages m JOIN sessions s ON s.sid = m.session_sid
             ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
             ORDER BY m.ts DESC LIMIT @cap`;
    }
    const now = Date.now();
    const rows = this.db.prepare(sql).all(params) as Array<Omit<Candidate, "score" | "coverage">>;
    return rows.map((r) => ({ ...r, coverage: 1, score: boost({ ...r, coverage: 1 }, currentProject, now) }));
  }

  /**
   * Fraction of the query's groups each candidate matches. One rowid-only scan per group
   * over the candidates' rowid range: asking FTS5 about each candidate rowid in turn
   * re-evaluates the whole expression (prefix terms included) once per rowid.
   */
  private measureCoverage(candidates: Candidate[], groupExprs: string[]): void {
    if (candidates.length === 0 || groupExprs.length <= 1) return;
    const ids = new Set(candidates.map((c) => c.id));
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of ids) {
      lo = Math.min(lo, id);
      hi = Math.max(hi, id);
    }
    const matched = new Map<number, number>();
    const stmt = this.db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid BETWEEN ? AND ?")
      .pluck();
    for (const expr of groupExprs) {
      for (const rowid of stmt.all(inText(expr), lo, hi) as number[]) {
        if (ids.has(rowid)) matched.set(rowid, (matched.get(rowid) ?? 0) + 1);
      }
    }
    for (const c of candidates) c.coverage = (matched.get(c.id) ?? 0) / groupExprs.length;
  }

  private group(candidates: Candidate[], sort: SortOrder): Group[] {
    const better = (a: Candidate, b: Candidate) => a.coverage > b.coverage || (a.coverage === b.coverage && a.score > b.score);
    const groups = new Map<number, Group>();
    for (const c of candidates) {
      const g = groups.get(c.sid);
      if (!g) {
        groups.set(c.sid, { best: c, count: 1, latest: c.ts ?? 0 });
        continue;
      }
      g.count++;
      g.latest = Math.max(g.latest, c.ts ?? 0);
      if (better(c, g.best)) g.best = c;
    }
    const list = [...groups.values()];
    if (sort === "recent") list.sort((a, b) => b.latest - a.latest);
    else list.sort((a, b) => (better(a.best, b.best) ? -1 : better(b.best, a.best) ? 1 : 0));
    return list;
  }

  private snippets(ids: number[], match: string | null): Map<number, { text: string; field: SearchHit["field"] }> {
    const out = new Map<number, { text: string; field: SearchHit["field"] }>();
    if (ids.length === 0) return out;
    const tokens = CONFIG.search.snippetTokens;
    const fields: SearchHit["field"][] = ["prose", "tool_input", "tool_output"];
    if (match) {
      const rows = this.db
        .prepare(
          `SELECT rowid,
             snippet(messages_fts, 0, '${OPEN}', '${CLOSE}', '…', ${tokens}) AS c0,
             snippet(messages_fts, 1, '${OPEN}', '${CLOSE}', '…', ${tokens}) AS c1,
             snippet(messages_fts, 2, '${OPEN}', '${CLOSE}', '…', ${tokens}) AS c2
           FROM messages_fts WHERE messages_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`
        )
        .all(match, JSON.stringify(ids)) as Array<{ rowid: number; c0: string; c1: string; c2: string }>;
      for (const row of rows) {
        const columns = [row.c0, row.c1, row.c2];
        const index = columns.findIndex((c) => c && c.includes(OPEN));
        const chosen = index === -1 ? 0 : index;
        out.set(row.rowid, { text: columns[chosen] ?? "", field: fields[chosen] });
      }
    }
    // No MATCH (filters only), or a row the snippet query missed: the start of the message.
    const missing = ids.filter((id) => !out.has(id));
    if (missing.length) {
      const rows = this.db
        .prepare("SELECT id, prose, tool_input, tool_output FROM message_text WHERE id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(missing)) as Array<{ id: number; prose: string; tool_input: string; tool_output: string }>;
      for (const row of rows) {
        const field: SearchHit["field"] = row.prose ? "prose" : row.tool_input ? "tool_input" : "tool_output";
        const text = row.prose || row.tool_input || row.tool_output;
        out.set(row.id, { text: text.length > 240 ? text.slice(0, 240) + "…" : text, field });
      }
    }
    return out;
  }

  private contextMessage(sid: number, seq: number): ContextMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT m.seq, m.role, m.ts, t.prose, t.tool_input, t.tool_output FROM messages m JOIN message_text t ON t.id = m.id
         WHERE m.session_sid = ? AND m.seq = ?`
      )
      .get(sid, seq) as { seq: number; role: string; ts: number | null; prose: string; tool_input: string; tool_output: string } | undefined;
    if (!row) return undefined;
    const text = [row.prose, row.tool_input, row.tool_output].filter(Boolean).join(" | ").replace(/\s+/g, " ");
    return { seq: row.seq, role: row.role, ts: row.ts, text: text.length > 300 ? text.slice(0, 300) + "…" : text };
  }

  private hydrate(picked: Array<{ group: Group; partial: boolean; match: string | null }>, includeContext: boolean): SearchHit[] {
    if (picked.length === 0) return [];
    const ids = picked.map((p) => p.group.best.id);
    const meta = new Map(
      (
        this.db
          .prepare(
            `SELECT m.id, m.session_sid AS sid, m.seq, m.role, m.ts, m.tools, s.id AS session_id, s.project, s.cwd,
               s.git_branch, s.source, s.is_subagent, s.parent_session, s.legacy, s.title
             FROM messages m JOIN sessions s ON s.sid = m.session_sid
             WHERE m.id IN (SELECT value FROM json_each(?))`
          )
          .all(JSON.stringify(ids)) as Array<{
          id: number; sid: number; seq: number; role: string; ts: number | null; tools: string; session_id: string;
          project: string; cwd: string | null; git_branch: string | null; source: string; is_subagent: number;
          parent_session: string | null; legacy: number; title: string | null;
        }>
      ).map((row) => [row.id, row])
    );
    const snippetsByMatch = new Map<string | null, Map<number, { text: string; field: SearchHit["field"] }>>();
    for (const match of new Set(picked.map((p) => p.match))) {
      snippetsByMatch.set(match, this.snippets(picked.filter((p) => p.match === match).map((p) => p.group.best.id), match));
    }

    const hits: SearchHit[] = [];
    for (const { group, partial, match } of picked) {
      const row = meta.get(group.best.id);
      if (!row) continue;
      const snip = snippetsByMatch.get(match)?.get(row.id) ?? { text: "", field: "prose" as const };
      const hit: SearchHit = {
        messageId: row.id,
        sessionId: row.session_id,
        seq: row.seq,
        role: row.role,
        ts: row.ts,
        tools: row.tools ? row.tools.split(" ") : [],
        project: row.project,
        cwd: row.cwd,
        branch: row.git_branch,
        source: row.source,
        isSubagent: row.is_subagent === 1,
        parentSession: row.parent_session,
        legacy: row.legacy === 1,
        title: row.title,
        snippet: snip.text.replace(/\s+/g, " ").replaceAll(OPEN, "**").replaceAll(CLOSE, "**").trim(),
        field: snip.field,
        otherHits: group.count - 1,
        partial,
        score: group.best.score,
      };
      if (includeContext) {
        hit.before = row.seq > 0 ? this.contextMessage(row.sid, row.seq - 1) : undefined;
        hit.after = this.contextMessage(row.sid, row.seq + 1);
      }
      hits.push(hit);
    }
    return hits;
  }

  search(rawQuery: string, options: SearchOptions = {}): SearchResponse {
    const query = parseQuery(rawQuery);
    if (options.project && !query.filters.project) query.filters.project = options.project;
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? CONFIG.search.defaultLimit), CONFIG.search.maxLimit));
    const sort = options.sort ?? "relevance";
    const includeContext = options.includeContext ?? false;
    const hasFilters = Object.values(query.filters).some((v) => v !== undefined);

    if (query.groups.length === 0 && !hasFilters) {
      return { query, hits: [], candidates: 0, capped: false, empty: true };
    }

    const scope = this.scopeFilters(query.filters);
    if (scope.none) return { query, hits: [], candidates: 0, capped: false, empty: false };
    // Candidates are found with the scope filters inside the MATCH; snippets only need the
    // text terms (FTS5 re-evaluates the whole expression for each snippet row).
    const textOnly = (expr: string | null) => (expr ? inText(expr) : null);
    const withScope = (expr: string | null) => (expr ? [inText(expr), ...scope.exprs].join(" AND ") : null);

    const strictText = strictMatch(query);
    const strictCandidates = this.candidates(withScope(strictText), query.filters, sort, options.currentProject);
    const picked: Array<{ group: Group; partial: boolean; match: string | null }> = this.group(strictCandidates, sort)
      .slice(0, limit)
      .map((group) => ({ group, partial: false, match: textOnly(strictText) }));
    let candidates = strictCandidates.length;
    let capped = strictCandidates.length >= CONFIG.search.candidateCap;

    const looseText = looseMatch(query);
    const tooFew = picked.length < Math.min(limit, 3);
    if (tooFew && looseText && looseText !== strictText) {
      const seen = new Set(picked.map((p) => p.group.best.sid));
      const looseCandidates = this.candidates(withScope(looseText), query.filters, sort, options.currentProject)
        .filter((c) => !seen.has(c.sid));
      this.measureCoverage(looseCandidates, looseGroups(query));
      candidates += looseCandidates.length;
      capped ||= looseCandidates.length >= CONFIG.search.candidateCap;
      for (const group of this.group(looseCandidates, sort)) {
        if (picked.length >= limit) break;
        picked.push({ group, partial: true, match: textOnly(looseText) });
      }
    }

    return { query, hits: this.hydrate(picked, includeContext), candidates, capped, empty: false };
  }
}
