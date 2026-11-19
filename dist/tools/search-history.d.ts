import type { SearchEngine, SortOrder } from "../search/search-engine.js";
export interface SearchHistoryArgs {
    query: string;
    project?: string;
    limit?: number;
    include_context?: boolean;
    sort?: SortOrder;
}
export declare function handleSearchHistory(engine: SearchEngine, args: SearchHistoryArgs, context?: {
    currentProject?: string;
    freshness?: string;
}): string;
//# sourceMappingURL=search-history.d.ts.map