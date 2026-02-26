export declare const findPatternsTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            project: {
                type: string;
                description: string;
            };
            type: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
export declare function handleFindPatterns(args: {
    project?: string;
    type?: string;
}): string;
//# sourceMappingURL=find-patterns.d.ts.map