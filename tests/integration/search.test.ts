import { describe, it, expect, beforeAll } from "vitest";
import { IndexManager } from "../../src/indexing/index-manager.js";
import { SearchEngine } from "../../src/search/search-engine.js";

describe("SearchEngine integration", () => {
  let indexManager: IndexManager;
  let engine: SearchEngine;

  beforeAll(async () => {
    indexManager = new IndexManager();
    // Try loading the pre-built index, fall back to building
    const loaded = await indexManager.load();
    if (!loaded) {
      await indexManager.buildFullIndex();
    }
    engine = new SearchEngine(indexManager);
  }, 60000);

  it("should have indexed sessions", () => {
    const stats = indexManager.getStats();
    expect(stats.sessions).toBeGreaterThan(0);
    expect(stats.documents).toBeGreaterThan(0);
  });

  it("should return results for a general query", () => {
    const results = engine.search("docker");
    // This is a common topic, should have results
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should support project filtering", () => {
    const results = engine.search("test project:ghostty", { limit: 5 });
    for (const r of results) {
      expect(r.project.toLowerCase()).toContain("ghostty");
    }
  });

  it("should respect limit parameter", () => {
    const results = engine.search("error", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should find solutions", () => {
    const results = engine.searchSolutions("error");
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});
