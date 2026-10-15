/**
 * One index writer at a time. Every Claude Code and Codex session starts its own copy
 * of this server; each keeps its in-memory index fresh, but only the lock holder writes
 * the (100+ MB) index to disk. A holder that has exited is replaced at the next save.
 */
export declare function claimWriterLock(lockFile?: string): boolean;
//# sourceMappingURL=writer-lock.d.ts.map