import { describe, it, expect } from "vitest";
import { extractContent, stripSystemReminders } from "../../src/parsers/content-extractor.js";

describe("extractContent", () => {
  it("should handle string content", () => {
    const result = extractContent("Hello, this is a test message");
    expect(result.text).toBe("Hello, this is a test message");
    expect(result.toolNames).toEqual([]);
  });

  it("should handle array content with text blocks", () => {
    const result = extractContent([
      { type: "text", text: "First part" },
      { type: "text", text: "Second part" },
    ]);
    expect(result.text).toContain("First part");
    expect(result.text).toContain("Second part");
  });

  it("should extract tool names from tool_use blocks", () => {
    const result = extractContent([
      { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.ts" } },
    ]);
    expect(result.toolNames).toEqual(["Bash", "Read"]);
  });

  it("should extract tool input snippets", () => {
    const result = extractContent([
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "docker build -t myapp ." },
      },
    ]);
    expect(result.toolInputSnippets).toContain("Bash: docker build -t myapp .");
  });

  it("should keep tool results given as a string", () => {
    const result = extractContent([{ type: "tool_result", content: "ECONNREFUSED 127.0.0.1:5432" }]);
    expect(result.toolResults.map((r) => r.text)).toEqual(["ECONNREFUSED 127.0.0.1:5432"]);
    expect(result.text).toBe("");
  });

  it("should keep tool results given as a block array", () => {
    const result = extractContent([
      { type: "tool_result", content: [{ type: "text", text: "first part" }, { type: "image" }, { type: "text", text: "second part" }] },
    ]);
    expect(result.toolResults.map((r) => r.text)).toEqual(["first part\n[image]\nsecond part"]);
  });

  it("should cap a tool result at about 2,000 characters", () => {
    const result = extractContent([{ type: "tool_result", content: "word ".repeat(2000) }]);
    expect(result.toolResults[0].text.length).toBeLessThanOrEqual(2000);
  });

  it("should replace binary-looking output", () => {
    const result = extractContent([{ type: "tool_result", content: "\u0000\u0001\u0002\u0003".repeat(50) }]);
    expect(result.toolResults.map((r) => r.text)).toEqual(["[binary output]"]);
  });

  it("should detect code blocks", () => {
    const result = extractContent("Here is code:\n```\nconst x = 1;\n```");
    expect(result.hasCode).toBe(true);
  });

  it("should handle undefined content", () => {
    const result = extractContent(undefined);
    expect(result.text).toBe("");
    expect(result.toolNames).toEqual([]);
  });

  it("should skip thinking blocks", () => {
    const result = extractContent([
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "visible response" },
    ]);
    expect(result.text).toContain("visible response");
    expect(result.text).not.toContain("internal reasoning");
  });

  it("should keep markdown and line breaks for reading back", () => {
    const result = extractContent("**bold** line\n\n\n\nnext `code`");
    expect(result.text).toBe("**bold** line\n\nnext `code`");
  });
});

describe("stripSystemReminders", () => {
  it("should remove system reminder tags", () => {
    const text =
      "Hello <system-reminder>hidden content</system-reminder> world";
    expect(stripSystemReminders(text)).toBe("Hello  world");
  });

  it("should handle multiline reminders", () => {
    const text =
      "Before <system-reminder>\nline 1\nline 2\n</system-reminder> After";
    expect(stripSystemReminders(text)).toBe("Before  After");
  });
});
