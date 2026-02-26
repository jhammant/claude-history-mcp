import { describe, it, expect } from "vitest";
import { parseQuery } from "../../src/search/query-processor.js";

describe("parseQuery", () => {
  it("should extract project filter", () => {
    const result = parseQuery("docker error project:ghostty");
    expect(result.text).toBe("docker error");
    expect(result.filters.project).toBe("ghostty");
  });

  it("should extract date filters", () => {
    const result = parseQuery("fix after:7d before:2024-12-01");
    expect(result.text).toBe("fix");
    expect(result.filters.after).toBeGreaterThan(0);
    expect(result.filters.before).toBeGreaterThan(0);
  });

  it("should extract tool filter", () => {
    const result = parseQuery("docker tool:Bash");
    expect(result.text).toBe("docker");
    expect(result.filters.tool).toBe("Bash");
  });

  it("should handle no filters", () => {
    const result = parseQuery("simple search query");
    expect(result.text).toBe("simple search query");
    expect(result.filters.project).toBeUndefined();
    expect(result.filters.before).toBeUndefined();
    expect(result.filters.after).toBeUndefined();
  });

  it("should handle multiple filters", () => {
    const result = parseQuery(
      "error project:myapp after:30d tool:Grep"
    );
    expect(result.text).toBe("error");
    expect(result.filters.project).toBe("myapp");
    expect(result.filters.after).toBeGreaterThan(0);
    expect(result.filters.tool).toBe("Grep");
  });

  it("should handle relative dates", () => {
    const before = Date.now();
    const result = parseQuery("test after:7d");
    const sevenDaysMs = 7 * 86400000;
    // Should be approximately now - 7 days
    expect(result.filters.after).toBeGreaterThan(before - sevenDaysMs - 1000);
    expect(result.filters.after).toBeLessThan(before - sevenDaysMs + 1000);
  });
});
