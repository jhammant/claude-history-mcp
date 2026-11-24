import { SOURCES, SOURCE_LABELS } from "../formats/types.js";
import { formatDateTime, hostCount, projectName, tildePath } from "../search/format.js";
import { distinctNames } from "../repos/resolve.js";
import { decodeProjectPath } from "../utils/path-encoder.js";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const MEMBERS_SHOWN = 5;
/**
 * Projects with history, one row per repository (sessions with no resolved repository are
 * grouped by project dir), newest first by default. A row is named by the repository's name,
 * never its remote URL, and lists its directories. Capped, because a long-lived database
 * holds hundreds of projects and the caller is a model with a context budget. Codex and pi sessions with no
 * messages (empty Codex guardian-review threads) are left out of the rows and their counts; every Claude session is counted.
 */
export function handleListProjects(db, args) {
    const dirs = db
        .prepare(`SELECT project, host, cwd, repo, max(repo_root) AS root,
         sum(is_subagent = 0) AS sessions, sum(is_subagent) AS subagents,
         sum(message_count) AS messages, min(start_time) AS first, max(end_time) AS last
       FROM sessions WHERE source = 'claude' OR message_count > 0 GROUP BY project, host, cwd, repo`)
        .all();
    // Per source: top-level sessions with at least one message. Subagent runs and empty Codex guardian-review
    // threads are left out so the breakdown matches the headline's top-level scope.
    const sourceRows = db
        .prepare(`SELECT project, host, repo, source, count(*) AS n FROM sessions WHERE (source = 'claude' OR message_count > 0) AND is_subagent = 0
       GROUP BY project, host, repo, source`)
        .all();
    if (dirs.length === 0)
        return "No projects with conversation history found.";
    // A session with no repository (one that never saw a working directory) joins the repository
    // of its project dir when exactly one repository has sessions there on the same host (one host's
    // evidence never applies to another), as it was counted with them before.
    const soleRepo = new Map();
    const soleKey = (r) => `${r.host}\0${r.project}`;
    for (const r of dirs) {
        if (r.repo === null)
            continue;
        const have = soleRepo.get(soleKey(r));
        soleRepo.set(soleKey(r), have === undefined || have === r.repo ? r.repo : null);
    }
    const repoOf = (r) => r.repo ?? soleRepo.get(soleKey(r)) ?? null;
    const keyOf = (r) => {
        const repo = repoOf(r);
        return repo !== null ? `r\0${repo}` : `p\0${r.project}`;
    };
    const groups = new Map();
    for (const r of dirs) {
        const key = keyOf(r);
        let g = groups.get(key);
        if (!g) {
            const repo = repoOf(r);
            const name = repo !== null ? "" : projectName(r.project, r.cwd); // repositories are named below
            groups.set(key, (g = { name, repo, hosts: new Set(), roots: new Map(), members: [], projects: new Set(), cwds: new Set(), sessions: 0, subagents: 0, messages: 0, first: null, last: null }));
        }
        g.projects.add(r.project);
        if (r.root)
            g.roots.set(r.root, (g.roots.get(r.root) ?? 0) + r.sessions + r.subagents);
        if (r.cwd)
            g.cwds.add(r.cwd);
        g.sessions += r.sessions;
        g.subagents += r.subagents;
        g.messages += r.messages;
        if (r.first !== null)
            g.first = g.first === null ? r.first : Math.min(g.first, r.first);
        if (r.last !== null)
            g.last = g.last === null ? r.last : Math.max(g.last, r.last);
        const dir = r.cwd ? tildePath(r.cwd) : decodeProjectPath(r.project);
        const have = g.members.find((m) => m.dir === dir);
        if (have)
            have.last = Math.max(have.last, r.last ?? 0);
        else
            g.members.push({ dir, decoded: !r.cwd, last: r.last ?? 0 });
    }
    // Repository rows by name; two different repositories of one name (or a name another row
    // already has) are told apart by checkout path, else numbered, as on the report page.
    const repoGroups = [...groups.values()].filter((g) => g.repo !== null);
    const names = distinctNames(repoGroups.map((g) => ({ key: g.repo, root: [...g.roots].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null })), (root) => tildePath(root), new Set([...groups.values()].filter((g) => g.repo === null).map((g) => g.name)));
    for (const g of repoGroups)
        g.name = names.get(g.repo);
    if (hostCount(db) > 1) {
        const hostRows = db
            .prepare("SELECT DISTINCT project, repo, host FROM sessions WHERE source = 'claude' OR message_count > 0")
            .all();
        for (const r of hostRows)
            groups.get(keyOf(r))?.hosts.add(r.host);
    }
    const bySource = new Map();
    for (const r of sourceRows) {
        const key = keyOf(r);
        if (!bySource.has(key))
            bySource.set(key, new Map());
        const counts = bySource.get(key);
        counts.set(r.source, (counts.get(r.source) ?? 0) + r.n);
    }
    const all = [...groups.entries()].map(([key, g]) => ({ key, ...g }));
    for (const g of all)
        g.members.sort((a, b) => b.last - a.last || a.dir.localeCompare(b.dir));
    const query = args.query?.trim().toLowerCase();
    const rows = query
        ? all.filter((g) => g.name.toLowerCase().includes(query) ||
            [...g.cwds, ...g.projects].some((d) => d.toLowerCase().includes(query)))
        : all;
    if (rows.length === 0)
        return `No projects match "${args.query}" (${all.length} projects have history).`;
    switch (args.sort_by ?? "recent") {
        case "sessions":
            rows.sort((a, b) => b.sessions - a.sessions);
            break;
        case "messages":
            rows.sort((a, b) => b.messages - a.messages);
            break;
        case "name":
            rows.sort((a, b) => a.name.localeCompare(b.name));
            break;
        default:
            rows.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    }
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
    const shown = rows.slice(0, limit);
    const lines = [
        `${rows.length} project${rows.length === 1 ? "" : "s"} with conversation history` +
            (query ? ` matching "${args.query}"` : "") +
            (shown.length < rows.length ? `, showing ${shown.length}:` : ":"),
        "",
    ];
    for (const row of shown) {
        const extras = [
            row.subagents ? `${row.subagents} subagent runs` : "",
            ...sourceCounts(bySource.get(row.key)),
        ].filter(Boolean);
        lines.push(`- ${row.name} — ${row.sessions} sessions, ${row.messages} messages` +
            (extras.length ? ` (${extras.join(", ")})` : ""));
        if (row.hosts.size) {
            lines.push(`  Hosts: ${[...row.hosts].map((h) => h || "unknown").sort().join(", ")}`);
        }
        const listed = row.members.slice(0, MEMBERS_SHOWN);
        const more = row.members.length - listed.length;
        if (listed.length === 1 && listed[0].decoded) {
            lines.push(`  Path (decoded, approximate): ${listed[0].dir}`);
        }
        else {
            lines.push(`  Director${row.members.length === 1 ? "y" : "ies"}: ` +
                listed.map((m) => m.dir + (m.decoded ? " (decoded, approximate)" : "")).join(", ") +
                (more > 0 ? ` +${more} more` : ""));
        }
        lines.push(`  Active: ${formatDateTime(row.first).slice(0, 10)} → ${formatDateTime(row.last).slice(0, 10)}`);
    }
    if (shown.length < rows.length) {
        lines.push("", `${rows.length - shown.length} more not shown. Narrow with query, or raise limit (max ${MAX_LIMIT}).`);
    }
    return lines.join("\n");
}
/** "2 Claude", "1 pi" for each source present; nothing when the project is all Claude (the default, no need to say). */
function sourceCounts(counts) {
    const present = SOURCES.filter((s) => (counts?.get(s) ?? 0) > 0);
    if (present.length === 0 || (present.length === 1 && present[0] === "claude"))
        return [];
    return present.map((s) => `${counts.get(s)} ${SOURCE_LABELS[s]}`);
}
//# sourceMappingURL=list-projects.js.map