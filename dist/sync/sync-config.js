/**
 * Cloud sync configuration — reads from environment variables.
 */
export function loadSyncConfig() {
    const apiUrl = process.env.CLAUDE_HISTORY_CLOUD_URL || '';
    const apiKey = process.env.CLAUDE_HISTORY_CLOUD_API_KEY || '';
    const teamId = process.env.CLAUDE_HISTORY_CLOUD_TEAM_ID || null;
    const enabled = !!(apiUrl && apiKey);
    const syncIntervalMs = parseInt(process.env.CLAUDE_HISTORY_SYNC_INTERVAL_MS || '300000', 10);
    return { apiUrl, apiKey, teamId, enabled, syncIntervalMs };
}
//# sourceMappingURL=sync-config.js.map