import { describe, it, expect } from "vitest";
import {
  parseHistoryFile,
  groupBySession,
  groupByProject,
  getProjectInfos,
} from "../../src/parsers/history-parser.js";

describe("history-parser", () => {
  it("should parse the history file", () => {
    const entries = parseHistoryFile();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty("display");
    expect(entries[0]).toHaveProperty("sessionId");
    expect(entries[0]).toHaveProperty("project");
    expect(entries[0]).toHaveProperty("timestamp");
  });

  it("should group by session", () => {
    const entries = parseHistoryFile();
    const groups = groupBySession(entries);
    expect(groups.size).toBeGreaterThan(0);
    for (const [_, sessionEntries] of groups) {
      const ids = new Set(sessionEntries.map((e) => e.sessionId));
      expect(ids.size).toBe(1);
    }
  });

  it("should group by project", () => {
    const entries = parseHistoryFile();
    const groups = groupByProject(entries);
    expect(groups.size).toBeGreaterThan(0);
    for (const [_, projectEntries] of groups) {
      const projects = new Set(projectEntries.map((e) => e.project));
      expect(projects.size).toBe(1);
    }
  });

  it("should generate project infos", () => {
    const entries = parseHistoryFile();
    const infos = getProjectInfos(entries);
    expect(infos.length).toBeGreaterThan(0);
    for (const info of infos) {
      expect(info.sessionCount).toBeGreaterThan(0);
      expect(info.messageCount).toBeGreaterThan(0);
    }
  });
});
