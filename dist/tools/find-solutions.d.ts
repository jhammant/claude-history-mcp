import type { SearchEngine } from "../search/search-engine.js";
export declare const findSolutionsTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            error_or_problem: {
                type: string;
                description: string;
            };
            technology: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleFindSolutions(engine: SearchEngine, args: {
    error_or_problem: string;
    technology?: string;
}): string;
//# sourceMappingURL=find-solutions.d.ts.map