/**
 * Persist and query extracted knowledge entries.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { CONFIG } from "../config.js";

export interface KnowledgeEntry {
  id: string;
  type: "decision" | "solution" | "error_fix" | "pattern";
  project: string;
  sessionId: string;
  timestamp: number;
  summary: string;
  details: string;
  tags: string[];
  relatedFiles: string[];
}

export class KnowledgeStore {
  private entries: KnowledgeEntry[] = [];

  addEntry(entry: KnowledgeEntry): void {
    // Deduplicate by summary similarity
    const existing = this.entries.find(
      (e) =>
        e.project === entry.project &&
        e.type === entry.type &&
        e.summary === entry.summary
    );
    if (existing) return;

    this.entries.push(entry);
  }

  /**
   * Find entries matching a query.
   */
  search(query: string, project?: string): KnowledgeEntry[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    return this.entries
      .filter((e) => {
        if (project && !e.project.toLowerCase().includes(project.toLowerCase()))
          return false;

        const text = `${e.summary} ${e.details} ${e.tags.join(" ")}`.toLowerCase();
        return queryWords.some((w) => text.includes(w));
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get entries for a project.
   */
  getProjectEntries(project: string): KnowledgeEntry[] {
    const query = project.toLowerCase();
    return this.entries
      .filter((e) => e.project.toLowerCase().includes(query))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get entries by type.
   */
  getByType(type: KnowledgeEntry["type"], project?: string): KnowledgeEntry[] {
    return this.entries
      .filter((e) => {
        if (e.type !== type) return false;
        if (project && !e.project.toLowerCase().includes(project.toLowerCase()))
          return false;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Save to disk.
   */
  save(): void {
    const dir = dirname(CONFIG.knowledgeFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG.knowledgeFile, JSON.stringify(this.entries, null, 2));
  }

  /**
   * Load from disk.
   */
  load(): boolean {
    if (!existsSync(CONFIG.knowledgeFile)) return false;
    try {
      const raw = readFileSync(CONFIG.knowledgeFile, "utf-8");
      this.entries = JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }

  getEntryCount(): number {
    return this.entries.length;
  }
}
