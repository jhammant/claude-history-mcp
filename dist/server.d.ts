/**
 * MCP server: a thin reader of the shared history database. No index is held in
 * memory and nothing runs between tool calls.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare const VERSION: string;
/** The command a user runs to build or refresh the database, as this install was started. */
export declare function sweepCommand(): string;
export declare function createServer(options?: {
    cwd?: string;
}): {
    server: McpServer;
    close: () => void;
};
//# sourceMappingURL=server.d.ts.map