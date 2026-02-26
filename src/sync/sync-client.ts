/**
 * Cloud Sync Client — push/pull knowledge entries and session summaries
 * to/from the ClaudeHistory Cloud backend.
 */

import { loadSyncConfig, type SyncConfig } from './sync-config.js';

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

export class SyncClient {
  private config: SyncConfig;

  constructor(config?: SyncConfig) {
    this.config = config || loadSyncConfig();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
  }

  private url(path: string): string {
    return `${this.config.apiUrl.replace(/\/$/, '')}${path}`;
  }

  /**
   * Push knowledge entries to the cloud.
   */
  async pushKnowledge(entries: KnowledgeEntry[]): Promise<{ accepted: number; errors: string[] }> {
    if (!this.config.enabled || entries.length === 0) {
      return { accepted: 0, errors: [] };
    }

    const body: Record<string, unknown> = { entries };
    if (this.config.teamId) body.teamId = this.config.teamId;

    const res = await fetch(this.url('/api/sync/push/knowledge'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { accepted: 0, errors: [`HTTP ${res.status}: ${text}`] };
    }

    return res.json() as Promise<{ accepted: number; errors: string[] }>;
  }

  /**
   * Push session summaries to the cloud.
   */
  async pushSessions(summaries: SessionSummary[]): Promise<{ accepted: number; errors: string[] }> {
    if (!this.config.enabled || summaries.length === 0) {
      return { accepted: 0, errors: [] };
    }

    const body: Record<string, unknown> = { summaries };
    if (this.config.teamId) body.teamId = this.config.teamId;

    const res = await fetch(this.url('/api/sync/push/sessions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { accepted: 0, errors: [`HTTP ${res.status}: ${text}`] };
    }

    return res.json() as Promise<{ accepted: number; errors: string[] }>;
  }

  /**
   * Pull knowledge entries from the cloud (team-shared).
   */
  async pullKnowledge(since?: number): Promise<KnowledgeEntry[]> {
    if (!this.config.enabled) return [];

    const params = new URLSearchParams();
    if (this.config.teamId) params.set('teamId', this.config.teamId);
    if (since) params.set('since', since.toString());

    const res = await fetch(this.url(`/api/sync/pull/knowledge?${params}`), {
      headers: this.headers(),
    });

    if (!res.ok) return [];

    const data = await res.json() as { entries: KnowledgeEntry[] };
    return data.entries || [];
  }

  /**
   * Pull session summaries from the cloud (team-shared).
   */
  async pullSessions(since?: number): Promise<SessionSummary[]> {
    if (!this.config.enabled) return [];

    const params = new URLSearchParams();
    if (this.config.teamId) params.set('teamId', this.config.teamId);
    if (since) params.set('since', since.toString());

    const res = await fetch(this.url(`/api/sync/pull/sessions?${params}`), {
      headers: this.headers(),
    });

    if (!res.ok) return [];

    const data = await res.json() as { summaries: SessionSummary[] };
    return data.summaries || [];
  }

  /**
   * Full sync: push local, pull remote.
   */
  async sync(
    localKnowledge: KnowledgeEntry[],
    localSessions: SessionSummary[],
    lastSyncTimestamp?: number
  ): Promise<SyncResult> {
    const errors: string[] = [];
    let pushed = 0;
    let pulled = 0;

    // Push
    const kPush = await this.pushKnowledge(localKnowledge);
    pushed += kPush.accepted;
    errors.push(...kPush.errors);

    const sPush = await this.pushSessions(localSessions);
    pushed += sPush.accepted;
    errors.push(...sPush.errors);

    // Pull
    const kPull = await this.pullKnowledge(lastSyncTimestamp);
    pulled += kPull.length;

    const sPull = await this.pullSessions(lastSyncTimestamp);
    pulled += sPull.length;

    return { pushed, pulled, errors };
  }
}
