/**
 * Extract knowledge entries (decisions, solutions, error fixes, patterns)
 * from parsed session data using heuristic pattern matching.
 */
import type { ParsedSession } from "./parsed-session.js";
import type { KnowledgeEntry } from "./knowledge-store.js";
/**
 * Extract knowledge from a single session.
 */
export declare function extractKnowledge(session: ParsedSession): KnowledgeEntry[];
//# sourceMappingURL=knowledge-extractor.d.ts.map