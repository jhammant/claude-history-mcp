import { extractProjectName } from "../utils/path-encoder.js";
export const findSolutionsTool = {
    name: "find_solutions",
    description: "Search past conversations for solutions to errors or problems. Prioritizes results containing fix/resolution language.",
    inputSchema: {
        type: "object",
        properties: {
            error_or_problem: {
                type: "string",
                description: "The error message, problem description, or issue to find solutions for",
            },
            technology: {
                type: "string",
                description: "Optional technology context (e.g., 'docker', 'typescript', 'react')",
            },
        },
        required: ["error_or_problem"],
    },
};
export function handleFindSolutions(engine, args) {
    const results = engine.searchSolutions(args.error_or_problem, args.technology);
    if (results.length === 0) {
        return `No past solutions found for "${args.error_or_problem}".`;
    }
    const lines = [
        `Found ${results.length} potential solution(s) for "${args.error_or_problem}":\n`,
    ];
    for (const r of results.slice(0, 10)) {
        const projectName = extractProjectName(r.project);
        const date = r.timestamp
            ? new Date(r.timestamp).toLocaleDateString()
            : "unknown date";
        lines.push(`--- ${projectName} (${date}) ---`);
        const text = r.text.length > 600 ? r.text.slice(0, 600) + "..." : r.text;
        lines.push(text);
        lines.push("");
    }
    return lines.join("\n");
}
//# sourceMappingURL=find-solutions.js.map