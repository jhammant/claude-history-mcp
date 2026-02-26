/**
 * Federation Client — communicates with the community pattern hub.
 * All federation features are OPT-IN (disabled by default).
 */

import { createHash } from 'crypto';
import type { CommunityPattern } from './privacy-filter.js';

export interface FederationConfig {
  enabled: boolean;
  hubUrl: string;
  contributorId: string; // anonymous hashed identifier
  timeout: number;       // request timeout in ms
}

export interface PatternSearchParams {
  query?: string;
  category?: string;
  platform?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface PatternSearchResult {
  patterns: CommunityPattern[];
  total: number;
  offset: number;
  limit: number;
}

export interface FederationStats {
  totalPatterns: number;
  totalContributors: number;
  topCategories: Array<{ category: string; count: number }>;
  lastUpdated: number;
}

export interface ContributeResult {
  accepted: number;
  rejected: number;
  merged: number;
  errors: string[];
}

function getDefaultConfig(): FederationConfig {
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
  private config: FederationConfig;

  constructor(config?: Partial<FederationConfig>) {
    this.config = { ...getDefaultConfig(), ...config };
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get hubUrl(): string {
    return this.config.hubUrl;
  }

  /**
   * Enable federation (opt-in).
   */
  enable(): void {
    this.config.enabled = true;
  }

  /**
   * Disable federation.
   */
  disable(): void {
    this.config.enabled = false;
  }

  /**
   * Submit anonymous patterns to the community hub.
   */
  async contribute(patterns: CommunityPattern[]): Promise<ContributeResult> {
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

    return response as ContributeResult;
  }

  /**
   * Pull community patterns, optionally filtered by tech stack.
   */
  async getPatterns(params: PatternSearchParams = {}): Promise<PatternSearchResult> {
    this.assertEnabled();

    const query = new URLSearchParams();
    if (params.category) query.set('category', params.category);
    if (params.platform) query.set('platform', params.platform);
    if (params.tags?.length) query.set('tags', params.tags.join(','));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));

    const qs = query.toString();
    return this.fetch(`/patterns${qs ? '?' + qs : ''}`) as Promise<PatternSearchResult>;
  }

  /**
   * Search community patterns by query string.
   */
  async searchPatterns(params: PatternSearchParams): Promise<PatternSearchResult> {
    this.assertEnabled();

    const query = new URLSearchParams();
    if (params.query) query.set('q', params.query);
    if (params.category) query.set('category', params.category);
    if (params.platform) query.set('platform', params.platform);
    if (params.tags?.length) query.set('tags', params.tags.join(','));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));

    const qs = query.toString();
    return this.fetch(`/patterns/search${qs ? '?' + qs : ''}`) as Promise<PatternSearchResult>;
  }

  /**
   * Get community stats.
   */
  async getStats(): Promise<FederationStats> {
    this.assertEnabled();
    return this.fetch('/stats') as Promise<FederationStats>;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error(
        'Federation is disabled. Enable with: claude-history-mcp federation enable\n' +
        'Or set CLAUDE_HISTORY_FEDERATION_ENABLED=true'
      );
    }
  }

  private async fetch(path: string, init?: RequestInit): Promise<unknown> {
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
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Federation request timed out after ${this.config.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
