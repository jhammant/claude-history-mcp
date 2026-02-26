/**
 * Cloud sync configuration — reads from environment variables.
 */
export interface SyncConfig {
    apiUrl: string;
    apiKey: string;
    teamId: string | null;
    enabled: boolean;
    syncIntervalMs: number;
}
export declare function loadSyncConfig(): SyncConfig;
//# sourceMappingURL=sync-config.d.ts.map