/**
 * MCP server: tool registration and request handling using McpServer API.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IndexManager } from "./indexing/index-manager.js";
import { SearchEngine } from "./search/search-engine.js";
import { handleSearchHistory } from "./tools/search-history.js";
import { handleListProjects } from "./tools/list-projects.js";
import { handleFindSolutions } from "./tools/find-solutions.js";
import { handleGetSessionSummary } from "./tools/get-session-summary.js";
import { handleGetProjectContext } from "./tools/get-project-context.js";
import { handleFindPatterns } from "./tools/find-patterns.js";
export function createServer() {
    const server = new McpServer({ name: "claude-history-mcp", version: "0.1.0" }, {
        capabilities: {
            tools: {},
        },
    });
    const indexManager = new IndexManager();
    const searchEngine = new SearchEngine(indexManager);
    let initialized = false;
    async function ensureIndex() {
        if (initialized)
            return;
        const loaded = await indexManager.load();
        if (loaded) {
            indexManager.incrementalUpdate().catch(() => { });
        }
        else {
            await indexManager.buildFullIndex();
            await indexManager.save().catch(() => { });
        }
        initialized = true;
    }
    // Register tools
    server.tool("search_history", "Search past Claude Code conversations. Supports filter syntax: project:name, before:date, after:date, tool:name. Dates can be relative (7d, 30d, 1w) or ISO (2024-01-15).", {
        query: z.string().describe("Search query. Can include filters like project:myapp before:7d"),
        project: z.string().optional().describe("Filter to a specific project name or path"),
        limit: z.number().optional().describe("Maximum results (default: 20, max: 100)"),
        include_context: z.boolean().optional().describe("Include surrounding message context (default: false)"),
    }, async (args) => {
        await ensureIndex();
        const result = handleSearchHistory(searchEngine, args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("list_projects", "List all projects that have Claude Code conversation history, with session counts and activity dates.", {
        sort_by: z.enum(["recent", "sessions", "messages", "name"]).optional().describe("Sort order (default: recent)"),
    }, async (args) => {
        const result = handleListProjects(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("find_solutions", "Search past conversations for solutions to errors or problems. Prioritizes results containing fix/resolution language.", {
        error_or_problem: z.string().describe("The error message, problem description, or issue to find solutions for"),
        technology: z.string().optional().describe("Optional technology context (e.g., 'docker', 'typescript', 'react')"),
    }, async (args) => {
        await ensureIndex();
        const result = handleFindSolutions(searchEngine, args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("get_session_summary", "Get a structured summary of a conversation session. Provide either a session ID or project name (returns most recent session).", {
        session_id: z.string().optional().describe("Specific session UUID"),
        project: z.string().optional().describe("Project name or path. Returns summary of most recent session."),
    }, async (args) => {
        const result = handleGetSessionSummary(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("get_project_context", "Get comprehensive context for a project: recent sessions, key topics, common tools, and patterns. Useful for session-start context injection.", {
        project: z.string().optional().describe("Project name or path. Defaults to current working directory."),
        depth: z.enum(["brief", "normal", "detailed"]).optional().describe("Detail level (default: normal)"),
    }, async (args) => {
        await ensureIndex();
        const result = handleGetProjectContext(searchEngine, args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("find_patterns", "Discover recurring patterns in conversation history: common topics, frequent workflows, repeated issues.", {
        project: z.string().optional().describe("Limit to a specific project"),
        type: z.enum(["topics", "workflows", "issues", "all"]).optional().describe("Type of patterns to find (default: all)"),
    }, async (args) => {
        const result = handleFindPatterns(args);
        return { content: [{ type: "text", text: result }] };
    });
    return {
        server,
        init: ensureIndex,
    };
}
//# sourceMappingURL=server.js.map