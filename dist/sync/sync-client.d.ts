/**
 * Cloud Sync Client — push/pull knowledge entries and session summaries
 * to/from the ClaudeHistory Cloud backend.
 */
import { type SyncConfig } from './sync-config.js';
export interface KnowledgeEntry {
    id?: string;
    type: string;
    project?: string;
    sessionId?: string;
    timestamp: number;
    summary: string;
    details?: string;
    tags?: string[];
    relatedFiles?: string[];
}
export interface SessionSummary {
    sessionId: string;
    project?: string;
    summary: Record<string, unknown>;
}
export interface SyncResult {
    pushed: number;
    pulled: number;
    errors: string[];
}
export declare class SyncClient {
    private config;
    constructor(config?: SyncConfig);
    get enabled(): boolean;
    private headers;
    private url;
    /**
     * Push knowledge entries to the cloud.
     */
    pushKnowledge(entries: KnowledgeEntry[]): Promise<{
        accepted: number;
        errors: string[];
    }>;
    /**
     * Push session summaries to the cloud.
     */
    pushSessions(summaries: SessionSummary[]): Promise<{
        accepted: number;
        errors: string[];
    }>;
    /**
     * Pull knowledge entries from the cloud (team-shared).
     */
    pullKnowledge(since?: number): Promise<KnowledgeEntry[]>;
    /**
     * Pull session summaries from the cloud (team-shared).
     */
    pullSessions(since?: number): Promise<SessionSummary[]>;
    /**
     * Full sync: push local, pull remote.
     */
    sync(localKnowledge: KnowledgeEntry[], localSessions: SessionSummary[], lastSyncTimestamp?: number): Promise<SyncResult>;
}
//# sourceMappingURL=sync-client.d.ts.map