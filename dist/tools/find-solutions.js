import { searchKnowledge } from "../knowledge/knowledge-store.js";
import { formatHit, projectName } from "../search/format.js";
import { tokenParts } from "../search/query-processor.js";
const SOLUTION_WORDS = /\b(fixed|solved|solution|resolved|the issue was|the problem was|root cause|worked|working now|works now)\b/i;
/** Does the hit, or one of the next three messages of its session, read like a fix? */
function looksSolved(db, hit) {
    if (SOLUTION_WORDS.test(hit.snippet))
        return true;
    const rows = db
        .prepare(`SELECT t.prose FROM messages m JOIN message_text t ON t.id = m.id
       WHERE m.session_sid = (SELECT sid FROM sessions WHERE id = ?) AND m.seq BETWEEN ? AND ? AND t.prose != ''`)
        .all(hit.sessionId, hit.seq, hit.seq + 3);
    return rows.some((r) => SOLUTION_WORDS.test(r.prose));
}
export function handleFindSolutions(db, engine, args, context = {}) {
    const problem = args.error_or_problem ?? "";
    const query = args.technology ? `${args.technology} ${problem}` : problem;
    const response = engine.search(query, { limit: 30, includeContext: true, currentProject: context.currentProject });
    const ranked = response.hits
        .map((hit) => ({ hit, score: hit.score * (looksSolved(db, hit) ? 1.5 : 1) * (hit.partial ? 0.5 : 1) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((r) => r.hit);
    const known = searchKnowledge(db, tokenParts(problem), 5, ["error_fix", "solution"]);
    if (ranked.length === 0 && known.length === 0) {
        return `No past solutions found for "${problem}".` + (context.freshness ? `\n${context.freshness}` : "");
    }
    const lines = [`${ranked.length} past conversation(s) about "${problem}", likeliest fixes first:`];
    if (context.freshness)
        lines.push(context.freshness);
    lines.push("");
    ranked.forEach((hit, i) => lines.push(...formatHit(hit, i + 1)));
    if (known.length) {
        lines.push("", "Extracted fixes:");
        for (const k of known)
            lines.push(`- [${k.type}] ${k.summary} (${projectName(k.project)}, session ${k.sessionId})`);
    }
    if (ranked.length)
        lines.push("", "Open a hit with read_session(session_id, around=<#>) to see the whole fix.");
    return lines.join("\n");
}
//# sourceMappingURL=find-solutions.js.map