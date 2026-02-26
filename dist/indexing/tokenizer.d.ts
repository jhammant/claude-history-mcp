/**
 * Tokenizer: lowercase → strip markdown → split → remove stop words → Porter stem → optional bigrams
 */
export interface TokenizeOptions {
    includeBigrams?: boolean;
    preserveCase?: boolean;
}
/**
 * Tokenize text for indexing or querying.
 * Returns stemmed tokens with stop words removed.
 */
export declare function tokenize(text: string, options?: TokenizeOptions): string[];
/**
 * Compute term frequencies for a token list.
 */
export declare function termFrequency(tokens: string[]): Map<string, number>;
//# sourceMappingURL=tokenizer.d.ts.map