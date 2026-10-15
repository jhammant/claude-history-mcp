#!/usr/bin/env node
/**
 * Claude History MCP Server — entry point.
 * Communicates over stdio transport.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
async function main() {
    const { server } = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // The SDK's stdio transport never notices stdin closing, so the server and its file
    // watchers would outlive their client. Close it here: onclose saves the index, then
    // nothing is left running and the process exits.
    process.stdin.on("end", () => {
        transport.close().catch(() => { });
    });
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map