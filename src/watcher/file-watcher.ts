/**
 * Debounced file watcher for session JSONL files.
 * Watches ~/.claude/projects/ for new or updated session files.
 */

import { watch, existsSync, type FSWatcher } from "fs";
import { CONFIG } from "../config.js";

export type FileChangeCallback = (filePath: string) => void;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;

  constructor(debounceMs = CONFIG.watcher.debounceMs) {
    this.debounceMs = debounceMs;
  }

  /**
   * Start watching the projects directory.
   */
  start(onChange: FileChangeCallback): void {
    const projectsDir = CONFIG.projectsDir;
    if (!existsSync(projectsDir)) return;

    this.watcher = watch(
      projectsDir,
      { recursive: true },
      (_event, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;

        // Debounce: wait for file to stop changing
        const existing = this.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          filename,
          setTimeout(() => {
            this.debounceTimers.delete(filename);
            onChange(filename);
          }, this.debounceMs)
        );
      }
    );
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
