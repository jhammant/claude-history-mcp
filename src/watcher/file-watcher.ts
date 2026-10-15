/**
 * Debounced file watcher for session JSONL files.
 * Watches ~/.claude/projects/ for new or updated session files.
 */

import { watch, existsSync, type FSWatcher } from "fs";
import { CONFIG } from "../config.js";
import { join } from "path";
import { enumerateSessionFiles } from "../parsers/session-parser.js";

export type FileChangeCallback = (filePath: string) => void;

const FAST_POLL_MS = 5_000;
const SAFETY_POLL_MS = 60_000;

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private safetyPollMs: number;
  private polling: ReturnType<typeof setInterval> | null = null;
  private known: Map<string, string> | null = null;

  constructor(debounceMs = CONFIG.watcher.debounceMs, safetyPollMs = SAFETY_POLL_MS) {
    this.debounceMs = debounceMs;
    this.safetyPollMs = safetyPollMs;
  }

  /**
   * Start watching the projects directory.
   */
  start(onChange: FileChangeCallback): void {
    this.stop();
    let native = 0;
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
          this.poll(onChange, FAST_POLL_MS);
        }));
        native++;
      } catch (error) {
        console.error('History native watcher unavailable; polling remains active.');
      }
    }
    // The poll covers newly created roots and dead native watchers. With native
    // watchers running it is only a safety net, so it need not stat every file often.
    this.poll(onChange, native > 0 ? this.safetyPollMs : FAST_POLL_MS);
  }

  private poll(onChange: FileChangeCallback, everyMs: number): void {
    if (this.polling) clearInterval(this.polling);
    const known = this.known ?? new Map(enumerateSessionFiles().map(f => [f.filePath, `${f.mtime}:${f.size}`]));
    this.known = known;
    this.polling = setInterval(() => {
      for (const f of enumerateSessionFiles()) {
        const signature = `${f.mtime}:${f.size}`;
        if (known.get(f.filePath) !== signature) onChange(f.filePath);
        known.set(f.filePath, signature);
      }
    }, Math.max(this.debounceMs, everyMs));
    this.polling.unref();
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
    this.known = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
