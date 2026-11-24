/**
 * Compact plain-text rendering of search hits, for a model to read.
 */
import type { DB } from "../db/database.js";
import type { SearchHit, SearchResponse } from "./search-engine.js";
/** Local date and time, e.g. 2026-11-19 14:02. */
export declare function formatDateTime(ms: number | null | undefined): string;
/** A path with the home directory shown as ~. */
export declare function tildePath(path: string, home?: string): string;
/**
 * How a project is labelled: its working directory (home shown as ~) when known, since
 * last segments alone (dev, api, tests) are ambiguous; otherwise the name taken from
 * the encoded project directory.
 */
export declare function projectName(project: string, cwd?: string | null): string;
/** Distinct hosts among the sessions; sessions with an unknown (empty) host do not count. */
export declare function hostCount(db: DB): number;
export declare function formatHit(hit: SearchHit, index: number, showHost?: boolean): string[];
export declare function formatSearchResponse(response: SearchResponse, rawQuery: string, freshness?: string): string;
//# sourceMappingURL=format.d.ts.map