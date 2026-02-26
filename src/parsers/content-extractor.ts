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

export function extractContent(
  content: string | ContentBlock[] | undefined
): ExtractedContent {
  const result: ExtractedContent = {
    text: "",
    toolNames: [],
    toolInputSnippets: [],
    hasCode: false,
  };

  if (!content) return result;

  if (typeof content === "string") {
    result.text = cleanText(content);
    result.hasCode = content.includes("```");
    return result;
  }

  if (!Array.isArray(content)) return result;

  const textParts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    switch (block.type) {
      case "text":
        if (block.text) textParts.push(block.text);
        break;

      case "tool_use":
        if (block.name) {
          result.toolNames.push(block.name);
          // Extract key parts of tool input for searchability
          if (block.input) {
            const snippet = extractToolInputSnippet(block.name, block.input);
            if (snippet) result.toolInputSnippets.push(snippet);
          }
        }
        break;

      case "tool_result":
        // Tool results can be string or nested content blocks
        if (typeof block.content === "string") {
          // Only take first 200 chars of tool results to avoid noise
          textParts.push(block.content.slice(0, 200));
        }
        break;

      case "thinking":
        // Skip thinking blocks — they're internal reasoning
        break;
    }
  }

  const combined = textParts.join("\n");
  result.text = cleanText(combined);
  result.hasCode = combined.includes("```");

  return result;
}

function extractToolInputSnippet(
  toolName: string,
  input: Record<string, unknown>
): string {
  // Extract meaningful parts depending on tool
  switch (toolName) {
    case "Read":
    case "read_file":
      return typeof input.file_path === "string" ? input.file_path : "";
    case "Write":
    case "write_file":
      return typeof input.file_path === "string" ? input.file_path : "";
    case "Edit":
    case "edit_file":
      return typeof input.file_path === "string" ? input.file_path : "";
    case "Bash":
    case "bash":
      return typeof input.command === "string"
        ? input.command.slice(0, 100)
        : "";
    case "Grep":
    case "grep":
      return typeof input.pattern === "string" ? input.pattern : "";
    case "Glob":
    case "glob":
      return typeof input.pattern === "string" ? input.pattern : "";
    case "WebSearch":
      return typeof input.query === "string" ? input.query : "";
    default:
      // For unknown tools, stringify a compact version
      try {
        return JSON.stringify(input).slice(0, 80);
      } catch {
        return "";
      }
  }
}

/**
 * Clean text for indexing: strip markdown formatting, normalize whitespace.
 */
function cleanText(text: string): string {
  return (
    text
      // Remove system reminders
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      // Remove HTML tags
      .replace(/<[^>]+>/g, " ")
      // Remove markdown code block markers (keep content)
      .replace(/```\w*\n?/g, " ")
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove markdown bold/italic markers
      .replace(/[*_]{1,3}/g, "")
      // Remove markdown headers markers
      .replace(/^#{1,6}\s/gm, "")
      // Normalize whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Strip system reminders from user message text.
 */
export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}
