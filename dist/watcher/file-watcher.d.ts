/**
 * Debounced file watcher for session JSONL files.
 * Watches ~/.claude/projects/ for new or updated session files.
 */
export type FileChangeCallback = (filePath: string) => void;
export declare class FileWatcher {
    private watcher;
    private debounceTimers;
    private debounceMs;
    constructor(debounceMs?: 5000);
    /**
     * Start watching the projects directory.
     */
    start(onChange: FileChangeCallback): void;
    /**
     * Stop watching.
     */
    stop(): void;
}
//# sourceMappingURL=file-watcher.d.ts.map