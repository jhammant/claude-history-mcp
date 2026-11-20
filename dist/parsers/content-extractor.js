/**
 * Turn one transcript line's message content into what gets stored and searched:
 * prose (what the user or assistant wrote), tool inputs (commands, paths, patterns)
 * and tool results. Thinking blocks are dropped; system reminders are stripped.
 *
 * Calls to this server's own tools keep their name but not their input, and are
 * reported so the caller can drop their results: a past search for X would otherwise
 * become a hit for X, repeating other sessions' text.
 */
import { CONFIG } from "../config.js";
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Long unbroken runs of base64/hex-like characters: images, keys, minified blobs. */
const BINARY_RUN = /[A-Za-z0-9+/=_-]{200,}/g;
const DATA_URI = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g;
/**
 * True for the wrapper Claude Code records when the user runs a local slash command
 * (/model, /clear ...) or its output. It is not something the user asked about, so it
 * should never become a session's topic or first prompt.
 */
export function isLocalCommandEcho(text) {
    return /^\s*<(command-name|command-message|local-command-[a-z]+)>/.test(text);
}
export function stripSystemReminders(text) {
    return text.replace(SYSTEM_REMINDER, "").trim();
}
/** Normalise prose for storage: keep markdown and line breaks, drop noise. */
export function cleanProse(text) {
    return stripSystemReminders(text)
        .replace(DATA_URI, "[data]")
        .replace(BINARY_RUN, "[binary]")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
export function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
/** A tool result as searchable text: binary removed, whitespace squeezed, capped. */
export function cleanToolResult(raw, max = CONFIG.limits.toolResultEach) {
    if (!raw)
        return "";
    let controlChars = 0;
    const probe = raw.slice(0, 4_000);
    for (let i = 0; i < probe.length; i++) {
        const code = probe.charCodeAt(i);
        if ((code < 9 || (code > 13 && code < 32)) || code === 0xfffd)
            controlChars++;
    }
    if (controlChars > probe.length * 0.05)
        return "[binary output]";
    const cleaned = stripSystemReminders(raw)
        .replace(DATA_URI, "[data]")
        .replace(BINARY_RUN, "[binary]")
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
    return truncate(cleaned, max);
}
/** Tool results come as a string or as an array of text/image/reference blocks. */
export function toolResultText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== "object")
            continue;
        const b = block;
        if (b.type === "text" && typeof b.text === "string")
            parts.push(b.text);
        else if (b.type === "image")
            parts.push("[image]");
    }
    return parts.join("\n");
}
const OWN_TOOL_NAMES = new Set([
    "search_history", "read_session", "list_projects", "find_solutions",
    "get_session_summary", "get_project_context", "find_patterns",
]);
const OWN_SERVER = /^claude[-_]?history(?:[-_]?mcp)?$/i;
/**
 * Is this a call to this server's own tools? MCP tool names look like
 * mcp__<server>__<tool> (Claude Code, and Codex in its feed) or <server>__<tool>.
 * The server part matches loosely: claude-history, claude_history, claude-history-mcp,
 * or any server with "history" in its name when the tool is one of ours.
 */
export function isOwnTool(name) {
    const parts = name.split(/__|\./).filter(Boolean);
    if (parts.length < 2)
        return false;
    const tool = parts[parts.length - 1].toLowerCase();
    const servers = parts.slice(0, -1).filter((p) => p.toLowerCase() !== "mcp");
    if (servers.some((server) => OWN_SERVER.test(server)))
        return true;
    return OWN_TOOL_NAMES.has(tool) && servers.some((server) => /history/i.test(server));
}
/** Codex feed: tool calls and results written into the message text as tagged blocks. */
const CODEX_TOOL_BLOCK = /\[external_agent_tool_call: ([^\]\n]+)\]([\s\S]*?)\[\/external_agent_tool_call\]|\[external_agent_tool_result(?:: [^\]\n]*)?\]([\s\S]*?)\[\/external_agent_tool_result\]/g;
function codexCallSnippet(name, rawInput) {
    const input = rawInput.trim().replace(/^input:\s*/, "");
    try {
        return toolInputSnippet(name, JSON.parse(input));
    }
    catch {
        return input ? truncate(`${name}: ${input}`, CONFIG.limits.toolInputEach) : name;
    }
}
/** Take Codex's tagged tool blocks out of a message string into the tool fields. */
function extractCodexToolBlocks(content, result) {
    if (!content.includes("[external_agent_tool_"))
        return content;
    return content.replace(CODEX_TOOL_BLOCK, (_match, callName, callInput, resultText) => {
        if (callName !== undefined) {
            const name = callName.trim();
            const own = isOwnTool(name);
            result.toolNames.push(name);
            result.textCalls.push(own);
            if (!own)
                result.toolInputSnippets.push(codexCallSnippet(name, callInput ?? ""));
        }
        else {
            result.toolResults.push({ text: cleanToolResult(resultText ?? "") });
        }
        return "\n";
    });
}
function str(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** The searchable part of a tool call's input: what it ran, read, searched or asked. */
export function toolInputSnippet(toolName, input) {
    const max = CONFIG.limits.toolInputEach;
    if (!input || typeof input !== "object")
        return "";
    const i = input;
    const name = toolName.toLowerCase();
    let detail;
    if (name === "bash" || name === "shell" || name === "exec_command") {
        detail = str(i.command) ?? str(i.cmd);
    }
    else if (["read", "write", "edit", "multiedit", "notebookedit", "read_file", "write_file", "edit_file"].includes(name)) {
        detail = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
    }
    else if (name === "grep" || name === "glob") {
        detail = [str(i.pattern), str(i.path), str(i.glob)].filter(Boolean).join(" in ");
    }
    else if (name === "websearch") {
        detail = str(i.query);
    }
    else if (name === "webfetch") {
        detail = [str(i.url), str(i.prompt)].filter(Boolean).join(" ");
    }
    else if (name === "task" || name === "agent") {
        detail = [str(i.description), str(i.prompt)].filter(Boolean).join(": ");
    }
    else if (name === "skill") {
        detail = [str(i.skill), str(i.args)].filter(Boolean).join(" ");
    }
    if (detail === undefined) {
        try {
            detail = JSON.stringify(input);
        }
        catch {
            detail = "";
        }
    }
    return detail ? truncate(`${toolName}: ${detail}`, max) : toolName;
}
export function extractContent(content) {
    const result = {
        text: "",
        toolNames: [],
        toolInputSnippets: [],
        toolResults: [],
        ownCallIds: [],
        textCalls: [],
        hasCode: false,
    };
    if (!content)
        return result;
    if (typeof content === "string") {
        result.text = cleanProse(extractCodexToolBlocks(content, result));
        result.hasCode = result.text.includes("```");
        return result;
    }
    if (!Array.isArray(content))
        return result;
    const textParts = [];
    for (const block of content) {
        if (!block || typeof block !== "object")
            continue;
        switch (block.type) {
            case "text":
                if (typeof block.text === "string")
                    textParts.push(block.text);
                break;
            case "tool_use":
                if (typeof block.name === "string") {
                    result.toolNames.push(block.name);
                    if (isOwnTool(block.name)) {
                        if (typeof block.id === "string")
                            result.ownCallIds.push(block.id);
                    }
                    else {
                        const snippet = toolInputSnippet(block.name, block.input);
                        if (snippet)
                            result.toolInputSnippets.push(snippet);
                    }
                }
                break;
            case "tool_result": {
                const text = cleanToolResult(toolResultText(block.content));
                const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
                result.toolResults.push({ toolUseId, text });
                break;
            }
            // thinking, redacted_thinking, image and anything else: not searchable prose
        }
    }
    result.text = cleanProse(textParts.join("\n\n"));
    result.hasCode = result.text.includes("```");
    return result;
}
//# sourceMappingURL=content-extractor.js.map