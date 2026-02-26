import { describe, it, expect, beforeEach } from "vitest";
import { BM25Index } from "../../src/indexing/bm25.js";

describe("BM25Index", () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  it("should return empty results for empty index", () => {
    expect(index.search(["test"])).toEqual([]);
  });

  it("should find documents by matching terms", () => {
    index.addDocument(0, ["docker", "network", "error"]);
    index.addDocument(1, ["react", "component", "render"]);
    index.addDocument(2, ["docker", "container", "build"]);

    const results = index.search(["docker"]);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.docId)).toContain(0);
    expect(results.map((r) => r.docId)).toContain(2);
  });

  it("should rank by relevance", () => {
    index.addDocument(0, ["docker", "docker", "network", "error"]);
    index.addDocument(1, ["docker", "react"]);

    const results = index.search(["docker"]);
    // Doc 0 has higher TF for "docker"
    expect(results[0].docId).toBe(0);
  });

  it("should handle multi-term queries", () => {
    index.addDocument(0, ["docker", "network", "error"]);
    index.addDocument(1, ["react", "network", "component"]);
    index.addDocument(2, ["docker", "container"]);

    const results = index.search(["docker", "network"]);
    // Doc 0 matches both terms
    expect(results[0].docId).toBe(0);
  });

  it("should remove documents", () => {
    index.addDocument(0, ["docker", "network"]);
    index.addDocument(1, ["docker", "container"]);

    index.removeDocument(0);

    const results = index.search(["network"]);
    expect(results.length).toBe(0);

    const dockerResults = index.search(["docker"]);
    expect(dockerResults.length).toBe(1);
    expect(dockerResults[0].docId).toBe(1);
  });

  it("should serialize and deserialize", () => {
    index.addDocument(0, ["hello", "world"]);
    index.addDocument(1, ["foo", "bar"]);

    const serialized = index.serialize();
    const restored = BM25Index.deserialize(serialized);

    const results = restored.search(["hello"]);
    expect(results.length).toBe(1);
    expect(results[0].docId).toBe(0);
    expect(restored.getDocumentCount()).toBe(2);
  });
});
