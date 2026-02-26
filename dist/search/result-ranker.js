/**
 * Score fusion using Reciprocal Rank Fusion (RRF), plus recency and project boosts.
 */
import { CONFIG } from "../config.js";
/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * RRF(d) = Σ 1 / (k + rank_i(d))
 */
export function reciprocalRankFusion(...rankedLists) {
    const k = CONFIG.search.rrfK;
    const scores = new Map();
    for (const list of rankedLists) {
        for (let rank = 0; rank < list.length; rank++) {
            const entry = list[rank];
            const rrfScore = 1 / (k + rank + 1);
            scores.set(entry.docId, (scores.get(entry.docId) || 0) + rrfScore);
        }
    }
    return scores;
}
/**
 * Apply post-retrieval boosts: recency, project match, deduplication.
 */
export function applyBoosts(results, filters, currentProject) {
    const now = Date.now();
    const boosted = results.map((r) => {
        let score = r.score;
        // Recency boost
        if (r.doc.timestamp > 0) {
            const ageMs = now - r.doc.timestamp;
            const ageDays = ageMs / 86400000;
            if (ageDays <= 7) {
                score *= CONFIG.search.recencyBoost7d;
            }
            else if (ageDays <= 30) {
                score *= CONFIG.search.recencyBoost30d;
            }
        }
        // Project match boost
        if (currentProject &&
            r.doc.project.toLowerCase().includes(currentProject.toLowerCase())) {
            score *= CONFIG.search.projectMatchBoost;
        }
        return { ...r, score };
    });
    // Deduplicate: if multiple chunks from same session, keep best
    const bestPerSession = new Map();
    for (const r of boosted) {
        const existing = bestPerSession.get(r.doc.sessionId);
        if (!existing || r.score > existing.score) {
            bestPerSession.set(r.doc.sessionId, r);
        }
    }
    // Sort by score
    const deduped = [...bestPerSession.values()];
    deduped.sort((a, b) => b.score - a.score);
    return deduped;
}
/**
 * Apply query filters to results.
 */
export function applyFilters(results, filters) {
    return results.filter((r) => {
        if (filters.project &&
            !r.doc.project.toLowerCase().includes(filters.project.toLowerCase())) {
            return false;
        }
        if (filters.before && r.doc.timestamp > filters.before) {
            return false;
        }
        if (filters.after && r.doc.timestamp < filters.after) {
            return false;
        }
        if (filters.tool &&
            !r.doc.toolNames.some((t) => t.toLowerCase().includes(filters.tool.toLowerCase()))) {
            return false;
        }
        return true;
    });
}
//# sourceMappingURL=result-ranker.js.map