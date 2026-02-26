import { describe, it, expect } from "vitest";
import { tokenize, termFrequency } from "../../src/indexing/tokenizer.js";

describe("tokenize", () => {
  it("should lowercase and stem tokens", () => {
    const tokens = tokenize("Running quickly towards solutions");
    expect(tokens).toContain("run");
    expect(tokens).toContain("quickli");
    expect(tokens).toContain("toward");
    expect(tokens).toContain("solut");
  });

  it("should remove stop words", () => {
    const tokens = tokenize("the quick brown fox is jumping over the lazy dog");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("is");
    expect(tokens).not.toContain("over");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
    expect(tokens).toContain("fox");
  });

  it("should handle empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("should remove URLs", () => {
    const tokens = tokenize("check https://example.com/path for details");
    expect(tokens.join(" ")).not.toContain("example");
    expect(tokens).toContain("check");
    expect(tokens).toContain("detail");
  });

  it("should include bigrams when requested", () => {
    const tokens = tokenize("docker network error", { includeBigrams: true });
    expect(tokens).toContain("docker");
    expect(tokens).toContain("network");
    expect(tokens).toContain("error");
    expect(tokens).toContain("docker_network");
    expect(tokens).toContain("network_error");
  });

  it("should skip very short tokens", () => {
    const tokens = tokenize("I a do it fix bug");
    // "a" is too short (length 1) and also a stop word
    expect(tokens.every((t) => t.length >= 2)).toBe(true);
  });
});

describe("termFrequency", () => {
  it("should count term occurrences", () => {
    const tokens = ["hello", "world", "hello", "foo", "hello"];
    const freq = termFrequency(tokens);
    expect(freq.get("hello")).toBe(3);
    expect(freq.get("world")).toBe(1);
    expect(freq.get("foo")).toBe(1);
  });

  it("should handle empty array", () => {
    const freq = termFrequency([]);
    expect(freq.size).toBe(0);
  });
});
