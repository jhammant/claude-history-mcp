/**
 * Federation Client — communicates with the community pattern hub.
 * All federation features are OPT-IN (disabled by default).
 */
import type { CommunityPattern } from './privacy-filter.js';
export interface FederationConfig {
    enabled: boolean;
    hubUrl: string;
    contributorId: string;
    timeout: number;
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
    topCategories: Array<{
        category: string;
        count: number;
    }>;
    lastUpdated: number;
}
export interface ContributeResult {
    accepted: number;
    rejected: number;
    merged: number;
    errors: string[];
}
export declare class FederationClient {
    private config;
    constructor(config?: Partial<FederationConfig>);
    get isEnabled(): boolean;
    get hubUrl(): string;
    /**
     * Enable federation (opt-in).
     */
    enable(): void;
    /**
     * Disable federation.
     */
    disable(): void;
    /**
     * Submit anonymous patterns to the community hub.
     */
    contribute(patterns: CommunityPattern[]): Promise<ContributeResult>;
    /**
     * Pull community patterns, optionally filtered by tech stack.
     */
    getPatterns(params?: PatternSearchParams): Promise<PatternSearchResult>;
    /**
     * Search community patterns by query string.
     */
    searchPatterns(params: PatternSearchParams): Promise<PatternSearchResult>;
    /**
     * Get community stats.
     */
    getStats(): Promise<FederationStats>;
    private assertEnabled;
    private fetch;
}
//# sourceMappingURL=federation-client.d.ts.map