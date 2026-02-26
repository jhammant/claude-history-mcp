/**
 * Privacy Filter — transforms private knowledge entries into anonymous community patterns.
 *
 * This is the core privacy gate. When in doubt, strip MORE data, not less.
 * No code, no names, no paths, no specific values ever leave the machine.
 */
export interface KnowledgeEntry {
    id: string;
    type: 'solution' | 'error_fix' | 'decision' | 'pattern';
    summary: string;
    details: string;
    tags?: string[];
    effectiveness?: number;
    sessionId: string;
    createdAt: number;
}
export interface CommunityPattern {
    id: string;
    type: 'solution' | 'error_fix' | 'decision' | 'pattern';
    category: string;
    platform?: string;
    approach: string;
    tags: string[];
    effectiveness: number;
    contributorCount: number;
    firstSeen: number;
    lastSeen: number;
}
interface FilterConfig {
    salt: string;
    kAnonymityThreshold: number;
}
/**
 * Strip all identifying information from text, replacing with generic placeholders.
 */
export declare function stripIdentifiers(text: string): string;
/**
 * Generalise an error message: keep the error type, strip everything specific.
 */
export declare function generaliseError(errorText: string): string;
/**
 * Hash a value with SHA-256 + salt for anonymous identification.
 */
export declare function hashWithSalt(value: string, salt?: string): string;
/**
 * Check k-anonymity: has this pattern been seen in k+ independent sessions?
 */
export declare function checkKAnonymity(entry: KnowledgeEntry, allEntries: KnowledgeEntry[], k?: number): boolean;
/**
 * Transform a private knowledge entry into an anonymous community pattern.
 * Returns null if the entry cannot be safely anonymised or fails k-anonymity.
 */
export declare function toAnonymousPattern(entry: KnowledgeEntry, allEntries: KnowledgeEntry[], config?: Partial<FilterConfig>): CommunityPattern | null;
/**
 * Batch-filter knowledge entries into anonymous patterns.
 * Only returns patterns that pass all privacy checks.
 */
export declare function filterBatch(entries: KnowledgeEntry[], config?: Partial<FilterConfig>): CommunityPattern[];
export {};
//# sourceMappingURL=privacy-filter.d.ts.map