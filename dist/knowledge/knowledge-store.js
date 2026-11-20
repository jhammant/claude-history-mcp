/**
 * Extracted knowledge (decisions, solutions, error fixes) in the database.
 */
function parseList(json) {
    try {
        const value = JSON.parse(json);
        return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    }
    catch {
        return [];
    }
}
function toEntry(row) {
    return {
        id: String(row.id),
        type: row.type,
        project: row.project,
        sessionId: row.session_id,
        timestamp: row.ts,
        summary: row.summary,
        details: row.details,
        tags: parseList(row.tags),
        relatedFiles: parseList(row.related_files),
    };
}
/**
 * Insert entries, skipping any whose (project, type, summary) is already known —
 * the same de-duplication the JSON store did.
 */
export function insertKnowledge(db, entries) {
    const insert = db.prepare(`INSERT OR IGNORE INTO knowledge(type, project, session_id, ts, summary, details, tags, related_files)
     VALUES (@type, @project, @sessionId, @timestamp, @summary, @details, @tags, @relatedFiles)`);
    let inserted = 0;
    for (const e of entries) {
        if (!e || typeof e.summary !== "string" || !e.summary || typeof e.type !== "string")
            continue;
        inserted += insert.run({
            type: e.type,
            project: e.project ?? "",
            sessionId: e.sessionId ?? "",
            timestamp: Number(e.timestamp) || 0,
            summary: e.summary,
            details: e.details ?? "",
            tags: JSON.stringify(e.tags ?? []),
            relatedFiles: JSON.stringify(e.relatedFiles ?? []),
        }).changes;
    }
    return inserted;
}
/** Replace what was extracted from one session (it is re-extracted as the session grows). */
export function replaceSessionKnowledge(db, sessionId, entries) {
    db.prepare("DELETE FROM knowledge WHERE session_id = ?").run(sessionId);
    insertKnowledge(db, entries);
}
/** Entries for a project (exact encoded dir, or a dir beneath it), newest first. */
export function projectKnowledge(db, project, type, limit) {
    const rows = db
        .prepare(`SELECT * FROM knowledge WHERE project >= ? AND project < ? AND type = ?
       ORDER BY ts DESC LIMIT ?`)
        .all(project, project + "￿", type, limit);
    return rows.map(toEntry);
}
/** Entries whose summary mentions any of the words, newest first. */
export function searchKnowledge(db, words, limit, types) {
    const usable = words.filter((w) => w.length >= 3).slice(0, 8);
    if (usable.length === 0)
        return [];
    const clauses = usable.map(() => "summary LIKE ? ESCAPE '\\'");
    const params = usable.map((w) => `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    let typeClause = "";
    if (types?.length) {
        typeClause = ` AND type IN (${types.map(() => "?").join(", ")})`;
        params.push(...types);
    }
    const rows = db
        .prepare(`SELECT * FROM knowledge WHERE (${clauses.join(" OR ")})${typeClause} ORDER BY ts DESC LIMIT ?`)
        .all(...params, limit);
    return rows.map(toEntry);
}
//# sourceMappingURL=knowledge-store.js.map