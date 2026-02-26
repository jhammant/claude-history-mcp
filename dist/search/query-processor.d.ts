/**
 * Parse query syntax: extract filters and clean query text.
 * Supports: project:name, before:date, after:date, tool:name, branch:name
 */
export interface ParsedQuery {
    text: string;
    filters: QueryFilters;
}
export interface QueryFilters {
    project?: string;
    before?: number;
    after?: number;
    tool?: string;
    branch?: string;
}
export declare function parseQuery(rawQuery: string): ParsedQuery;
//# sourceMappingURL=query-processor.d.ts.map