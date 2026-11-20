/**
 * Turn one transcript line's message content into what gets stored and searched:
 * prose (what the user or assistant wrote), tool inputs (commands, paths, patterns)
 * and tool results. Thinking blocks are dropped; system reminders are stripped.
 *
 * Calls to this server's own tools keep their name but not their input, and are
 * reported so the caller can drop their results: a past search for X would otherwise
 * become a hit for X, repeating other sessions' text.
 */
export interface ToolResult {
    /** The tool_use id it answers (Claude). Codex feed results carry none: they follow their call. */
    toolUseId?: string;
    text: string;
}
export interface ExtractedContent {
    /** User or assistant prose, markdown kept, system reminders removed. */
    text: string;
    toolNames: string[];
    /** One entry per tool call, e.g. "Bash: npm test" or "Read: src/app.ts" (none for own tools). */
    toolInputSnippets: string[];
    /**
     * One entry per tool result, each capped and cleaned of binary data. Empty results are
     * listed too: Codex results are paired with their calls by order, so none may go missing.
     */
    toolResults: ToolResult[];
    /** tool_use ids of calls to this server's own tools, whose results must not be indexed. */
    ownCallIds: string[];
    /** Codex feed calls in order (true = this server's own tool); results answer them in turn. */
    textCalls: boolean[];
    hasCode: boolean;
}
export interface ContentBlock {
    type: string;
    id?: string;
    tool_use_id?: string;
    text?: string;
    name?: string;
    input?: unknown;
    content?: unknown;
    thinking?: string;
}
/**
 * True for the wrapper Claude Code records when the user runs a local slash command
 * (/model, /clear ...) or its output. It is not something the user asked about, so it
 * should never become a session's topic or first prompt.
 */
export declare function isLocalCommandEcho(text: string): boolean;
export declare function stripSystemReminders(text: string): string;
/** Normalise prose for storage: keep markdown and line breaks, drop noise. */
export declare function cleanProse(text: string): string;
export declare function truncate(text: string, max: number): string;
/** A tool result as searchable text: binary removed, whitespace squeezed, capped. */
export declare function cleanToolResult(raw: string, max?: number): string;
/** Tool results come as a string or as an array of text/image/reference blocks. */
export declare function toolResultText(content: unknown): string;
/**
 * Is this a call to this server's own tools? MCP tool names look like
 * mcp__<server>__<tool> (Claude Code, and Codex in its feed) or <server>__<tool>.
 * The server part matches loosely: claude-history, claude_history, claude-history-mcp,
 * or any server with "history" in its name when the tool is one of ours.
 */
export declare function isOwnTool(name: string): boolean;
/** The searchable part of a tool call's input: what it ran, read, searched or asked. */
export declare function toolInputSnippet(toolName: string, input: unknown): string;
export declare function extractContent(content: string | ContentBlock[] | undefined | unknown): ExtractedContent;
//# sourceMappingURL=content-extractor.d.ts.map