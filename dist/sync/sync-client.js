/**
 * Cloud Sync Client — push/pull knowledge entries and session summaries
 * to/from the ClaudeHistory Cloud backend.
 */
import { loadSyncConfig } from './sync-config.js';
export class SyncClient {
    config;
    constructor(config) {
        this.config = config || loadSyncConfig();
    }
    get enabled() {
        return this.config.enabled;
    }
    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
        };
    }
    url(path) {
        return `${this.config.apiUrl.replace(/\/$/, '')}${path}`;
    }
    /**
     * Push knowledge entries to the cloud.
     */
    async pushKnowledge(entries) {
        if (!this.config.enabled || entries.length === 0) {
            return { accepted: 0, errors: [] };
        }
        const body = { entries };
        if (this.config.teamId)
            body.teamId = this.config.teamId;
        const res = await fetch(this.url('/api/sync/push/knowledge'), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            return { accepted: 0, errors: [`HTTP ${res.status}: ${text}`] };
        }
        return res.json();
    }
    /**
     * Push session summaries to the cloud.
     */
    async pushSessions(summaries) {
        if (!this.config.enabled || summaries.length === 0) {
            return { accepted: 0, errors: [] };
        }
        const body = { summaries };
        if (this.config.teamId)
            body.teamId = this.config.teamId;
        const res = await fetch(this.url('/api/sync/push/sessions'), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            return { accepted: 0, errors: [`HTTP ${res.status}: ${text}`] };
        }
        return res.json();
    }
    /**
     * Pull knowledge entries from the cloud (team-shared).
     */
    async pullKnowledge(since) {
        if (!this.config.enabled)
            return [];
        const params = new URLSearchParams();
        if (this.config.teamId)
            params.set('teamId', this.config.teamId);
        if (since)
            params.set('since', since.toString());
        const res = await fetch(this.url(`/api/sync/pull/knowledge?${params}`), {
            headers: this.headers(),
        });
        if (!res.ok)
            return [];
        const data = await res.json();
        return data.entries || [];
    }
    /**
     * Pull session summaries from the cloud (team-shared).
     */
    async pullSessions(since) {
        if (!this.config.enabled)
            return [];
        const params = new URLSearchParams();
        if (this.config.teamId)
            params.set('teamId', this.config.teamId);
        if (since)
            params.set('since', since.toString());
        const res = await fetch(this.url(`/api/sync/pull/sessions?${params}`), {
            headers: this.headers(),
        });
        if (!res.ok)
            return [];
        const data = await res.json();
        return data.summaries || [];
    }
    /**
     * Full sync: push local, pull remote.
     */
    async sync(localKnowledge, localSessions, lastSyncTimestamp) {
        const errors = [];
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
//# sourceMappingURL=sync-client.js.map