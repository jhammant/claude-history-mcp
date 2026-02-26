/**
 * Tokenizer: lowercase → strip markdown → split → remove stop words → Porter stem → optional bigrams
 */
import { stem } from "../utils/stemmer.js";
const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will",
    "with", "i", "me", "my", "we", "our", "you", "your", "he", "she", "its",
    "him", "her", "do", "did", "does", "has", "have", "had", "can", "could",
    "would", "should", "may", "might", "shall", "am", "been", "being", "were",
    "what", "which", "who", "whom", "how", "when", "where", "why", "so", "than",
    "too", "very", "just", "about", "above", "after", "again", "all", "also",
    "any", "because", "before", "between", "both", "each", "few", "from",
    "further", "get", "got", "here", "more", "most", "other", "out", "over",
    "own", "same", "some", "still", "through", "under", "up", "while",
    // Common in code conversations but not useful for search
    "let", "use", "using", "used", "need", "want", "like", "make", "see",
    "look", "think", "know", "going", "try", "run", "file", "code",
]);
/**
 * Tokenize text for indexing or querying.
 * Returns stemmed tokens with stop words removed.
 */
export function tokenize(text, options = {}) {
    if (!text)
        return [];
    let processed = text.toLowerCase();
    // Remove URLs
    processed = processed.replace(/https?:\/\/\S+/g, " ");
    // Remove file paths but keep meaningful parts
    processed = processed.replace(/(?:\/[\w.-]+){3,}/g, (match) => {
        // Keep just the filename
        const parts = match.split("/");
        return parts[parts.length - 1] || "";
    });
    // Remove non-alphanumeric (keep hyphens and underscores between words)
    processed = processed.replace(/[^a-z0-9_-]/g, " ");
    // Split on whitespace and separators
    const rawTokens = processed
        .split(/[\s_-]+/)
        .filter((t) => t.length >= 2 && t.length <= 40);
    // Remove stop words and stem
    const stemmed = [];
    for (const token of rawTokens) {
        if (STOP_WORDS.has(token))
            continue;
        // Skip pure numbers unless they look like error codes
        if (/^\d+$/.test(token) && token.length < 3)
            continue;
        stemmed.push(stem(token));
    }
    // Optionally add bigrams
    if (options.includeBigrams && stemmed.length >= 2) {
        const bigrams = [];
        for (let i = 0; i < stemmed.length - 1; i++) {
            bigrams.push(`${stemmed[i]}_${stemmed[i + 1]}`);
        }
        return [...stemmed, ...bigrams];
    }
    return stemmed;
}
/**
 * Compute term frequencies for a token list.
 */
export function termFrequency(tokens) {
    const freq = new Map();
    for (const token of tokens) {
        freq.set(token, (freq.get(token) || 0) + 1);
    }
    return freq;
}
//# sourceMappingURL=tokenizer.js.map