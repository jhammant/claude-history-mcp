/**
 * MCP Tool: search_community_knowledge
 *
 * Searches the federated community hub for patterns matching a query.
 * Only available when federation is enabled (opt-in).
 */
export interface SearchCommunityInput {
    query: string;
    category?: string;
    platform?: string;
    tags?: string[];
    limit?: number;
}
export interface SearchCommunityResult {
    patterns: FormattedPattern[];
    total: number;
    federationEnabled: boolean;
}
interface FormattedPattern {
    type: string;
    category: string;
    platform?: string;
    approach: string;
    tags: string[];
    effectiveness: number;
    contributorCount: number;
    firstSeen: string;
    lastSeen: string;
}
/**
 * MCP tool definition for registration with the MCP server.
 */
export declare const searchCommunityKnowledgeTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            query: {
                type: string;
                description: string;
            };
            category: {
                type: string;
                description: string;
            };
            platform: {
                type: string;
                description: string;
            };
            tags: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
/**
 * Execute the search_community_knowledge tool.
 */
export declare function executeSearchCommunityKnowledge(input: SearchCommunityInput): Promise<SearchCommunityResult>;
export {};
//# sourceMappingURL=search-community.d.ts.map