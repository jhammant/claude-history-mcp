import { encodeProjectPath } from "../utils/path-encoder.js";
function likeEscape(value) {
    return value.replace(/[\\%_]/g, (c) => "\\" + c);
}
/**
 * Encoded project dirs matching what a caller typed: a path (exact dir, or dirs beneath
 * it), an encoded dir, or part of a name ("ghostty" matches -Users-me-dev-ghostty).
 */
export function matchProjects(db, query) {
    const q = query.trim();
    if (!q)
        return [];
    const encoded = q.includes("/") ? encodeProjectPath(q.replace(/\/+$/, "")) : q;
    const exact = db
        .prepare("SELECT DISTINCT project FROM sessions WHERE project >= ? AND project < ?")
        .all(encoded, encoded + "￿");
    if (exact.length)
        return exact.map((r) => r.project);
    const like = `%${likeEscape(q)}%`;
    const rows = db
        .prepare("SELECT DISTINCT project FROM sessions WHERE project LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\'")
        .all(like, like);
    return rows.map((r) => r.project);
}
/** SQL placeholder list and values for an IN (...) over projects. */
export function inList(values) {
    return { sql: values.map(() => "?").join(", "), params: values };
}
//# sourceMappingURL=project-match.js.map