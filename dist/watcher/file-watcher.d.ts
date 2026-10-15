/**
 * Debounced file watcher for session JSONL files.
 * Watches ~/.claude/projects/ for new or updated session files.
 */
export type FileChangeCallback = (filePath: string) => void;
export declare class FileWatcher {
    private watchers;
    private debounceTimers;
    private debounceMs;
    private safetyPollMs;
    private polling;
    private known;
    constructor(debounceMs?: 5000, safetyPollMs?: number);
    /**
     * Start watching the projects directory.
     */
    start(onChange: FileChangeCallback): void;
    private poll;
    /**
     * Stop watching.
     */
    stop(): void;
}
//# sourceMappingURL=file-watcher.d.ts.map