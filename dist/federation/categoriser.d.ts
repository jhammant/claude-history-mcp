/**
 * Pattern Categoriser — auto-categorises knowledge entries into a technology taxonomy.
 * Uses keyword matching only, no LLM calls.
 */
export interface CategoryMatch {
    category: string;
    subcategory: string;
    confidence: number;
}
/**
 * Categorise a knowledge entry by matching keywords against summary + details.
 * Returns all matching categories sorted by confidence (highest first).
 */
export declare function categorise(summary: string, details?: string): CategoryMatch[];
/**
 * Get the best category string (e.g. "frameworks/react" or "databases/postgresql").
 * Returns "general" if no match found.
 */
export declare function bestCategory(summary: string, details?: string): string;
/**
 * Extract technology tags from text using the taxonomy keywords.
 * Returns unique subcategory names that matched.
 */
export declare function extractTechTags(summary: string, details?: string): string[];
//# sourceMappingURL=categoriser.d.ts.map