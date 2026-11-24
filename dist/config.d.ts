export declare const CONFIG: {
    readonly claudeDir: string;
    readonly projectsDir: string;
    readonly codexProjectsDir: string;
    readonly codexSessionsDir: string;
    readonly piSessionsDir: string;
    readonly settingsFile: string;
    readonly dataDir: string;
    readonly databaseFile: string;
    /** Files of the pre-SQLite store, read only by `import-legacy`. */
    legacy: {
        readonly indexFile: string;
        readonly knowledgeFile: string;
        readonly summariesDir: string;
    };
    /** Query-time top-up: index transcripts changed since the last sweep within this budget. */
    readonly topUpBudgetMs: number;
    topUpIntervalMs: number;
    search: {
        defaultLimit: number;
        maxLimit: number;
        /** Hits considered before grouping by session. */
        candidateCap: number;
        /** bm25 column weights: prose, tool input, tool output (the scope column weighs 0). */
        weights: readonly [1, 0.5, 0.25];
        /**
         * Session filters matching at most this many sessions run inside the FTS MATCH.
         * Measured on a large history: up to ~100 sessions it cuts a cold search from ~170 to
         * ~65 ms for a few ms when warm; from ~200 the long OR costs more than it saves.
         */
        scopeMaxSessions: number;
        recencyBoost: number;
        recencyHalfLifeDays: number;
        currentProjectBoost: number;
        subagentFactor: number;
        snippetTokens: number;
    };
    /** Caps on what is stored per message (characters). */
    limits: {
        prose: number;
        toolInputEach: number;
        toolInputTotal: number;
        toolResultEach: number;
        toolOutputTotal: number;
        firstPrompt: number;
    };
};
//# sourceMappingURL=config.d.ts.map