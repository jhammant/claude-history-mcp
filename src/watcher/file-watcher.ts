/**
 * Debounced file watcher for session JSONL files.
 * Watches ~/.claude/projects/ for new or updated session files.
 */

import { watch, existsSync, type FSWatcher } from "fs";
import { CONFIG } from "../config.js";
import { join } from "path";
import { enumerateSessionFiles } from "../parsers/session-parser.js";

export type FileChangeCallback = (filePath: string) => void;

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private polling: ReturnType<typeof setInterval> | null = null;

  constructor(debounceMs = CONFIG.watcher.debounceMs) {
    this.debounceMs = debounceMs;
  }

  /**
   * Start watching the projects directory.
   */
  start(onChange: FileChangeCallback): void {
    this.stop();
    // Also covers newly created roots and unavailable/exhausted native watchers.
    const known = new Map(enumerateSessionFiles().map(f => [f.filePath, `${f.mtime}:${f.size}`]));
    this.polling = setInterval(() => {
      for (const f of enumerateSessionFiles()) {
        const signature = `${f.mtime}:${f.size}`;
        if (known.get(f.filePath) !== signature) onChange(f.filePath);
        known.set(f.filePath, signature);
      }
    }, Math.max(this.debounceMs, 5000));
    this.polling.unref();
    for (const projectsDir of CONFIG.projectRoots) {
    if (!existsSync(projectsDir)) continue;
    try {
    this.watchers.push(watch(
      projectsDir,
      { recursive: true },
      (_event, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        filename = join(projectsDir, filename);

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
    ).on('error', error => {
      console.error('History native watcher unavailable; polling remains active:', error.message);
    }));
    } catch (error) {
      console.error('History native watcher unavailable; polling remains active.');
    }
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
