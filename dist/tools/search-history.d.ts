import type { SearchEngine } from "../search/search-engine.js";
export declare const searchHistoryTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            query: {
                type: string;
                description: string;
            };
            project: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            include_context: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleSearchHistory(engine: SearchEngine, args: {
    query: string;
    project?: string;
    limit?: number;
    include_context?: boolean;
}): string;
//# sourceMappingURL=search-history.d.ts.map