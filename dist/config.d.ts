export declare const CONFIG: {
    readonly claudeDir: string;
    readonly historyFile: string;
    readonly projectsDir: string;
    readonly settingsFile: string;
    readonly dataDir: string;
    readonly indexFile: string;
    readonly knowledgeFile: string;
    readonly summariesDir: string;
    readonly metaFile: string;
    readonly bm25: {
        readonly k1: 1.2;
        readonly b: 0.75;
    };
    readonly tfidf: {
        readonly maxTerms: 10000;
    };
    readonly search: {
        readonly defaultLimit: 20;
        readonly maxLimit: 100;
        readonly contextLines: 3;
        readonly recencyBoost7d: 1.2;
        readonly recencyBoost30d: 1.1;
        readonly projectMatchBoost: 1.3;
        readonly rrfK: 60;
    };
    readonly indexing: {
        readonly chunkSize: 500;
        readonly chunkOverlap: 50;
        readonly maxChunksPerSession: 200;
    };
    readonly watcher: {
        readonly debounceMs: 5000;
        readonly staleSessionMinutes: 5;
    };
};
//# sourceMappingURL=config.d.ts.map