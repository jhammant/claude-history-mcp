import { homedir, hostname } from "os";
import { join } from "path";
/**
 * Every path is read from the environment at the moment it is used, so tests,
 * benchmarks and alternative installs can point the code at other directories
 * without touching HOME.
 *
 *   CLAUDE_HISTORY_DATA_DIR      where history.db lives (default ~/.claude-history-mcp)
 *   CLAUDE_HISTORY_CLAUDE_DIR    Claude Code's config dir (default ~/.claude)
 *   CLAUDE_HISTORY_PROJECTS_DIR  Claude Code transcripts (default <claude dir>/projects)
 *   CODEX_TRANSCRIPT_FEED        Codex feed root (default <CODEX_HOME>/transcript-feed)
 *   CLAUDE_HISTORY_CODEX_SESSIONS_DIR  native Codex rollouts (default <CODEX_HOME or ~/.codex>/sessions)
 *   CLAUDE_HISTORY_PI_SESSIONS_DIR  native pi sessions (default ~/.pi/agent/sessions)
 *   CODEX_HOME                   Codex home (default ~/.codex)
 *   CLAUDE_HISTORY_TOPUP_MS      query-time indexing budget in ms (default 300, 0 = off)
 *   CLAUDE_HISTORY_HOST          name of this machine on every session it indexes (default: the hostname up to its first dot)
 *   CLAUDE_HISTORY_REPO_MAP_DIR  directory-to-repository maps recorded per machine (default <data dir>/repo-map)
 *   CLAUDE_HISTORY_REPO_HOST_ALIASES  git host aliases, a=b,c=d (alias host a is the same as b)
 *   CLAUDE_HISTORY_WORKTREE_DIRS  comma-separated folder names that hold a repository's worktrees
 *                                (default .worktrees,worktrees; set but empty = none)
 */
function env(name) {
    const value = process.env[name];
    return value && value.trim() ? value : undefined;
}
/** A host name safe to store, show and use as a file name: [A-Za-z0-9._-], no leading . or -, at most 64 characters. */
export function cleanHostName(raw) {
    const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]/, "_").slice(0, 64);
    return cleaned || "localhost";
}
export const CONFIG = {
    get claudeDir() {
        return env("CLAUDE_HISTORY_CLAUDE_DIR") ?? join(homedir(), ".claude");
    },
    get projectsDir() {
        return env("CLAUDE_HISTORY_PROJECTS_DIR") ?? join(this.claudeDir, "projects");
    },
    get codexProjectsDir() {
        const feed = env("CODEX_TRANSCRIPT_FEED") ??
            join(env("CODEX_HOME") ?? join(homedir(), ".codex"), "transcript-feed");
        return join(feed, "projects");
    },
    get codexSessionsDir() {
        return env("CLAUDE_HISTORY_CODEX_SESSIONS_DIR") ?? join(env("CODEX_HOME") ?? join(homedir(), ".codex"), "sessions");
    },
    get piSessionsDir() {
        return env("CLAUDE_HISTORY_PI_SESSIONS_DIR") ?? join(homedir(), ".pi", "agent", "sessions");
    },
    get settingsFile() {
        return join(this.claudeDir, "settings.json");
    },
    get dataDir() {
        return env("CLAUDE_HISTORY_DATA_DIR") ?? join(homedir(), ".claude-history-mcp");
    },
    /** This machine's name, recorded on each session when it is first indexed. */
    get host() {
        return cleanHostName(env("CLAUDE_HISTORY_HOST") ?? hostname().split(".")[0]);
    },
    get repoMapDir() {
        return env("CLAUDE_HISTORY_REPO_MAP_DIR") ?? join(this.dataDir, "repo-map");
    },
    get repoHostAliases() {
        return env("CLAUDE_HISTORY_REPO_HOST_ALIASES");
    },
    /** Folder names directly under a repository that hold its worktrees. */
    get worktreeDirs() {
        const raw = process.env.CLAUDE_HISTORY_WORKTREE_DIRS;
        if (raw === undefined)
            return [".worktrees", "worktrees"];
        return raw.split(",").map((d) => d.trim()).filter((d) => d && !d.includes("/") && d !== "." && d !== "..");
    },
    get databaseFile() {
        return join(this.dataDir, "history.db");
    },
    /** Files of the pre-SQLite store, read only by `import-legacy`. */
    legacy: {
        get indexFile() {
            return join(CONFIG.dataDir, "index.msgpack");
        },
        get knowledgeFile() {
            return join(CONFIG.dataDir, "knowledge.json");
        },
        get summariesDir() {
            return join(CONFIG.dataDir, "summaries");
        },
    },
    /** Query-time top-up: index transcripts changed since the last sweep within this budget. */
    get topUpBudgetMs() {
        const raw = env("CLAUDE_HISTORY_TOPUP_MS");
        const parsed = raw === undefined ? NaN : Number(raw);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300;
    },
    topUpIntervalMs: 20_000,
    search: {
        defaultLimit: 10,
        maxLimit: 50,
        /** Hits considered before grouping by session. */
        candidateCap: 3000,
        /** bm25 column weights: prose, tool input, tool output (the scope column weighs 0). */
        weights: [1.0, 0.5, 0.25],
        /**
         * Session filters matching at most this many sessions run inside the FTS MATCH.
         * Measured on a large history: up to ~100 sessions it cuts a cold search from ~170 to
         * ~65 ms for a few ms when warm; from ~200 the long OR costs more than it saves.
         */
        scopeMaxSessions: 120,
        recencyBoost: 0.25,
        recencyHalfLifeDays: 30,
        currentProjectBoost: 1.3,
        subagentFactor: 0.85,
        snippetTokens: 28,
    },
    /** Caps on what is stored per message (characters). */
    limits: {
        prose: 50_000,
        toolInputEach: 1_000,
        toolInputTotal: 8_000,
        toolResultEach: 2_000,
        toolOutputTotal: 16_000,
        firstPrompt: 300,
    },
};
//# sourceMappingURL=config.js.map