export declare const listProjectsTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            sort_by: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
export declare function handleListProjects(args: {
    sort_by?: string;
}): string;
//# sourceMappingURL=list-projects.d.ts.map