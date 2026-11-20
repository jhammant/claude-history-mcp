#!/usr/bin/env node
/**
 * Claude History MCP — one entry point.
 *
 *   node dist/index.js                  run the MCP server over stdio
 *   node dist/index.js <command> ...    sweep | rebuild | status | import-legacy | search | help
 */
import { COMMANDS } from "./cli/command-names.js";
async function startServer() {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createServer } = await import("./server.js");
    const { server } = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // The SDK's stdio transport never notices stdin closing; close it so the process exits.
    process.stdin.on("end", () => {
        transport.close().catch(() => { });
    });
}
async function main() {
    const command = process.argv[2];
    if (command && COMMANDS.includes(command)) {
        const { runCommand } = await import("./cli/commands.js");
        process.exitCode = await runCommand(command, process.argv.slice(3));
        return;
    }
    if (command) {
        console.error(`Unknown command "${command}". Commands: ${COMMANDS.join(", ")}. With no command, runs the MCP server.`);
        process.exitCode = 2;
        return;
    }
    await startServer();
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map