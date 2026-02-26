/**
 * Federation Client — communicates with the community pattern hub.
 * All federation features are OPT-IN (disabled by default).
 */
import { createHash } from 'crypto';
function getDefaultConfig() {
    const machineId = process.env.USER || process.env.HOSTNAME || 'anonymous';
    const salt = process.env.CLAUDE_HISTORY_FEDERATION_SALT || 'claude-history-federation';
    return {
        enabled: process.env.CLAUDE_HISTORY_FEDERATION_ENABLED === 'true',
        hubUrl: process.env.CLAUDE_HISTORY_FEDERATION_URL || 'https://api.claude-history.dev/api/federation',
        contributorId: createHash('sha256').update(`${salt}:${machineId}`).digest('hex'),
        timeout: 15_000,
    };
}
export class FederationClient {
    config;
    constructor(config) {
        this.config = { ...getDefaultConfig(), ...config };
    }
    get isEnabled() {
        return this.config.enabled;
    }
    get hubUrl() {
        return this.config.hubUrl;
    }
    /**
     * Enable federation (opt-in).
     */
    enable() {
        this.config.enabled = true;
    }
    /**
     * Disable federation.
     */
    disable() {
        this.config.enabled = false;
    }
    /**
     * Submit anonymous patterns to the community hub.
     */
    async contribute(patterns) {
        this.assertEnabled();
        if (patterns.length === 0) {
            return { accepted: 0, rejected: 0, merged: 0, errors: [] };
        }
        const response = await this.fetch('/contribute', {
            method: 'POST',
            body: JSON.stringify({
                contributorHash: this.config.contributorId,
                patterns,
            }),
        });
        return response;
    }
    /**
     * Pull community patterns, optionally filtered by tech stack.
     */
    async getPatterns(params = {}) {
        this.assertEnabled();
        const query = new URLSearchParams();
        if (params.category)
            query.set('category', params.category);
        if (params.platform)
            query.set('platform', params.platform);
        if (params.tags?.length)
            query.set('tags', params.tags.join(','));
        if (params.limit)
            query.set('limit', String(params.limit));
        if (params.offset)
            query.set('offset', String(params.offset));
        const qs = query.toString();
        return this.fetch(`/patterns${qs ? '?' + qs : ''}`);
    }
    /**
     * Search community patterns by query string.
     */
    async searchPatterns(params) {
        this.assertEnabled();
        const query = new URLSearchParams();
        if (params.query)
            query.set('q', params.query);
        if (params.category)
            query.set('category', params.category);
        if (params.platform)
            query.set('platform', params.platform);
        if (params.tags?.length)
            query.set('tags', params.tags.join(','));
        if (params.limit)
            query.set('limit', String(params.limit));
        if (params.offset)
            query.set('offset', String(params.offset));
        const qs = query.toString();
        return this.fetch(`/patterns/search${qs ? '?' + qs : ''}`);
    }
    /**
     * Get community stats.
     */
    async getStats() {
        this.assertEnabled();
        return this.fetch('/stats');
    }
    // ── Internal ────────────────────────────────────────────────────────────
    assertEnabled() {
        if (!this.config.enabled) {
            throw new Error('Federation is disabled. Enable with: claude-history-mcp federation enable\n' +
                'Or set CLAUDE_HISTORY_FEDERATION_ENABLED=true');
        }
    }
    async fetch(path, init) {
        const url = `${this.config.hubUrl}${path}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout);
        try {
            const response = await globalThis.fetch(url, {
                ...init,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Contributor-Hash': this.config.contributorId,
                    'User-Agent': 'claude-history-mcp-federation/1.0',
                    ...init?.headers,
                },
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`Federation hub returned ${response.status}: ${body}`);
            }
            return response.json();
        }
        catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`Federation request timed out after ${this.config.timeout}ms`);
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=federation-client.js.map