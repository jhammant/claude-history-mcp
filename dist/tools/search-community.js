/**
 * MCP Tool: search_community_knowledge
 *
 * Searches the federated community hub for patterns matching a query.
 * Only available when federation is enabled (opt-in).
 */
import { FederationClient } from '../federation/federation-client.js';
function formatPattern(p) {
    return {
        type: p.type,
        category: p.category,
        platform: p.platform,
        approach: p.approach,
        tags: p.tags,
        effectiveness: p.effectiveness,
        contributorCount: p.contributorCount,
        firstSeen: new Date(p.firstSeen).toISOString(),
        lastSeen: new Date(p.lastSeen).toISOString(),
    };
}
/**
 * MCP tool definition for registration with the MCP server.
 */
export const searchCommunityKnowledgeTool = {
    name: 'search_community_knowledge',
    description: 'Search the federated community knowledge hub for anonymised patterns, solutions, and error fixes ' +
        'contributed by other developers. Returns patterns with contributor counts and effectiveness scores. ' +
        'Only available when federation is enabled (opt-in via `claude-history-mcp federation enable`).',
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search query — describe the problem, error, or pattern you\'re looking for',
            },
            category: {
                type: 'string',
                description: 'Filter by category (e.g. "frameworks/react", "databases/postgresql", "patterns/caching")',
            },
            platform: {
                type: 'string',
                description: 'Filter by platform (e.g. "aws", "vercel", "docker")',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by technology tags',
            },
            limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10, max: 50)',
            },
        },
        required: ['query'],
    },
};
/**
 * Execute the search_community_knowledge tool.
 */
export async function executeSearchCommunityKnowledge(input) {
    const client = new FederationClient();
    if (!client.isEnabled) {
        return {
            patterns: [],
            total: 0,
            federationEnabled: false,
        };
    }
    try {
        const result = await client.searchPatterns({
            query: input.query,
            category: input.category,
            platform: input.platform,
            tags: input.tags,
            limit: Math.min(input.limit || 10, 50),
        });
        return {
            patterns: result.patterns.map(formatPattern),
            total: result.total,
            federationEnabled: true,
        };
    }
    catch (error) {
        // Graceful degradation — federation failures should never break the MCP
        return {
            patterns: [],
            total: 0,
            federationEnabled: true,
        };
    }
}
//# sourceMappingURL=search-community.js.map