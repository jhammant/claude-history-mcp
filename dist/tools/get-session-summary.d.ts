export declare const getSessionSummaryTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            session_id: {
                type: string;
                description: string;
            };
            project: {
                type: string;
                description: string;
            };
        };
    };
};
export declare function handleGetSessionSummary(args: {
    session_id?: string;
    project?: string;
}): string;
//# sourceMappingURL=get-session-summary.d.ts.map