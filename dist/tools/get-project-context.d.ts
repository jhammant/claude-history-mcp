import type { SearchEngine } from "../search/search-engine.js";
export declare const getProjectContextTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            project: {
                type: string;
                description: string;
            };
            depth: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
export declare function handleGetProjectContext(engine: SearchEngine, args: {
    project?: string;
    depth?: string;
}): string;
//# sourceMappingURL=get-project-context.d.ts.map