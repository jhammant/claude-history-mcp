/**
 * Compact plain-text rendering of search hits, for a model to read.
 */
import { homedir } from "os";
import { sep } from "path";
import { extractProjectName } from "../utils/path-encoder.js";
function pad(n) {
    return String(n).padStart(2, "0");
}
/** Local date and time, e.g. 2026-11-19 14:02. */
export function formatDateTime(ms) {
    if (!ms)
        return "unknown date";
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** A path with the home directory shown as ~. */
export function tildePath(path, home = homedir()) {
    if (!home)
        return path;
    if (path === home)
        return "~";
    return path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}
/**
 * How a project is labelled: its working directory (home shown as ~) when known, since
 * last segments alone (dev, api, tests) are ambiguous; otherwise the name taken from
 * the encoded project directory.
 */
export function projectName(project, cwd) {
    return cwd ? tildePath(cwd) : extractProjectName(project);
}
function contextLine(label, m) {
    return m ? `   ${label} #${m.seq} ${m.role}: ${m.text}` : null;
}
export function formatHit(hit, index) {
    const tags = [];
    if (hit.source !== "claude")
        tags.push(hit.source);
    if (hit.isSubagent)
        tags.push(`subagent of ${hit.parentSession ?? "unknown session"}`);
    if (hit.legacy)
        tags.push("archived (old index)");
    if (hit.partial)
        tags.push("partial match");
    const tools = hit.tools.length ? ` [${[...new Set(hit.tools)].slice(0, 6).join(", ")}]` : "";
    const where = hit.field === "prose" ? "" : ` (in ${hit.field === "tool_input" ? "tool input" : "tool output"})`;
    const more = hit.otherHits > 0 ? ` · +${hit.otherHits} more hit${hit.otherHits === 1 ? "" : "s"} in session` : "";
    const lines = [
        `${index}. ${projectName(hit.project, hit.cwd)} · ${formatDateTime(hit.ts)} · session ${hit.sessionId} · ${hit.role} #${hit.seq}${tools}${more}` +
            (tags.length ? ` · ${tags.join(" · ")}` : ""),
    ];
    if (hit.title)
        lines.push(`   title: ${hit.title}`);
    const before = contextLine("before", hit.before);
    if (before)
        lines.push(before);
    lines.push(`   ${hit.snippet || "(no text)"}${where}`);
    const after = contextLine("after", hit.after);
    if (after)
        lines.push(after);
    return lines;
}
export function formatSearchResponse(response, rawQuery, freshness) {
    if (response.empty) {
        return "Empty query. Give search words and/or filters, e.g. `docker compose project:myapp after:7d`.";
    }
    const lines = [];
    if (response.hits.length === 0) {
        lines.push(`No matches for "${rawQuery}".`);
    }
    else {
        const exact = response.hits.filter((h) => !h.partial).length;
        const partial = response.hits.length - exact;
        const how = response.query.groups.length === 0
            ? "most recent messages matching the filters"
            : partial === 0
                ? "every hit matches all terms"
                : exact === 0
                    ? "no session matches all terms; showing partial matches"
                    : `${exact} match all terms, ${partial} partial`;
        lines.push(`${response.hits.length} session${response.hits.length === 1 ? "" : "s"} for "${rawQuery}" (${how}):`);
    }
    if (freshness)
        lines.push(freshness);
    lines.push("");
    response.hits.forEach((hit, i) => {
        lines.push(...formatHit(hit, i + 1));
    });
    if (response.hits.length > 0) {
        lines.push("", "Open a hit with read_session(session_id, around=<#>).");
    }
    return lines.join("\n");
}
//# sourceMappingURL=format.js.map