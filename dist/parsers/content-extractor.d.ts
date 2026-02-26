/**
 * Extract searchable text from Claude Code message content.
 * Handles both string content (user messages) and array content (assistant messages).
 */
export interface ExtractedContent {
    text: string;
    toolNames: string[];
    toolInputSnippets: string[];
    hasCode: boolean;
}
interface ContentBlock {
    type: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: string | ContentBlock[];
    thinking?: string;
}
export declare function extractContent(content: string | ContentBlock[] | undefined): ExtractedContent;
/**
 * Strip system reminders from user message text.
 */
export declare function stripSystemReminders(text: string): string;
export {};
//# sourceMappingURL=content-extractor.d.ts.map