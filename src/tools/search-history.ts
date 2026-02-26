import type { SearchEngine } from "../search/search-engine.js";
import { extractProjectName } from "../utils/path-encoder.js";

export const searchHistoryTool = {
  name: "search_history",
  description:
    "Search past Claude Code conversations. Supports filter syntax: project:name, before:date, after:date, tool:name. Dates can be relative (7d, 30d, 1w) or ISO (2024-01-15).",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Search query. Can include filters like project:myapp before:7d",
      },
      project: {
        type: "string",
        description: "Filter to a specific project name or path",
      },
      limit: {
        type: "number",
        description: "Maximum results (default: 20, max: 100)",
      },
      include_context: {
        type: "boolean",
        description: "Include surrounding message context (default: false)",
      },
    },
    required: ["query"],
  },
};

export function handleSearchHistory(
  engine: SearchEngine,
  args: {
    query: string;
    project?: string;
    limit?: number;
    include_context?: boolean;
  }
): string {
  const results = engine.search(args.query, {
    limit: args.limit,
    project: args.project,
    includeContext: args.include_context,
  });

  if (results.length === 0) {
    return `No results found for "${args.query}".`;
  }

  const lines: string[] = [`Found ${results.length} result(s) for "${args.query}":\n`];

  for (const r of results) {
    const projectName = extractProjectName(r.project);
    const date = r.timestamp
      ? new Date(r.timestamp).toLocaleDateString()
      : "unknown date";
    const toolInfo =
      r.toolNames.length > 0 ? ` [tools: ${r.toolNames.join(", ")}]` : "";

    lines.push(`--- ${projectName} (${date})${toolInfo} ---`);
    // Truncate long text
    const text = r.text.length > 500 ? r.text.slice(0, 500) + "..." : r.text;
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}
