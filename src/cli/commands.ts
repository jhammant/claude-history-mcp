/**
 * Command-line commands. Each returns a process exit code.
 */

import { spawnSync } from "child_process";
import { statSync } from "fs";
import { getHeapStatistics } from "v8";
import { CONFIG } from "../config.js";
import { DatabaseMissingError, DatabaseOutdatedError, getMeta, openDatabase, type DB } from "../db/database.js";
import { SOURCES, SOURCE_LABELS, type Source } from "../formats/types.js";
import { importLegacy } from "../indexing/legacy-import.js";
import { rebuild } from "../indexing/rebuild.js";
import { changedTranscripts, sweep, SweepBusyError, topUp, type SweepStats } from "../indexing/sweep.js";
import { recordRepos } from "../repos/probe.js";
import { formatDateTime } from "../search/format.js";
import { SearchEngine, type SortOrder } from "../search/search-engine.js";
import { handleSearchHistory } from "../tools/search-history.js";
import { encodeProjectPath } from "../utils/path-encoder.js";

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    const takesValue = ["limit", "project", "sort"].includes(name);
    if (inline !== undefined) flags.set(name, inline);
    else if (takesValue && i + 1 < argv.length) flags.set(name, argv[++i]);
    else flags.set(name, true);
  }
  return { positional, flags };
}

const n = (value: number) => value.toLocaleString("en-US");

function bytes(size: number): string {
  if (size >= 1 << 30) return `${(size / (1 << 30)).toFixed(2)} GB`;
  if (size >= 1 << 20) return `${(size / (1 << 20)).toFixed(1)} MB`;
  return `${(size / 1024).toFixed(0)} KB`;
}

function progressWriter(): ((line: string) => void) | undefined {
  return process.stderr.isTTY ? (line) => process.stderr.write(line + "\n") : undefined;
}

/** Claude lines skipped as already indexed, when there were any. */
function duplicateLine(stats: SweepStats): string {
  const d = stats.duplicates;
  const total = d.sameSession + d.otherSession + d.beforeUpgrade;
  if (!total) return "";
  const parts = [d.sameSession && `${n(d.sameSession)} from a copy of the same session`, d.otherSession && `${n(d.otherSession)} held by another session`,
    d.beforeUpgrade && `${n(d.beforeUpgrade)} indexed before the upgrade`].filter(Boolean);
  return `; ${n(total)} copied lines skipped (${parts.join(", ")})`;
}

function sweepLine(stats: SweepStats): string {
  const changed = stats.changed === 0
    ? "Nothing changed"
    : `Indexed ${n(stats.indexed)} of ${n(stats.changed)} changed transcripts (+${n(stats.messagesAdded)} messages` +
      `${stats.reset ? `, ${stats.reset} re-read from scratch` : ""}${stats.raced ? `, ${stats.raced} left to another indexer` : ""}` +
      `${duplicateLine(stats)})`;
  return `${changed} in ${(stats.ms / 1000).toFixed(1)} s; ${n(stats.transcripts)} transcripts on disk, ` +
    `${n(stats.sessions)} sessions and ${n(stats.messages)} messages in the database (${bytes(stats.databaseBytes)})` +
    `${stats.summarized ? `; ${n(stats.summarized)} summaries refreshed` : ""}${stats.optimized ? "; search index optimised" : ""}` +
    `${stats.vacuumed ? "; database compacted" : ""}.`;
}

function runSweep(args: ParsedArgs): number {
  const db = openDatabase(CONFIG.databaseFile, { create: true });
  try {
    const stats = sweep(db, { progress: progressWriter() });
    console.log(args.flags.has("json") ? JSON.stringify(stats) : sweepLine(stats));
    return 0;
  } catch (error) {
    if (error instanceof SweepBusyError) {
      console.log(args.flags.has("json") ? JSON.stringify({ skipped: true, reason: error.message }) : `${error.message} Leaving it to finish.`);
      return 0;
    }
    throw error;
  } finally {
    db.close();
  }
}

async function runRebuild(args: ParsedArgs): Promise<number> {
  try {
    const stats = await rebuild(CONFIG.databaseFile, progressWriter());
    console.log(
      args.flags.has("json")
        ? JSON.stringify(stats)
        : `Rebuilt: ${sweepLine(stats.sweep)} Kept ${n(stats.carriedSessions)} archived sessions (${n(stats.carriedMessages)} messages) whose transcripts are gone` +
          `${stats.carriedSharedLines ? ` (${n(stats.carriedSharedLines)} of their lines also held by a re-read session)` : ""}.`
    );
    return 0;
  } catch (error) {
    if (error instanceof SweepBusyError) {
      console.log(`${error.message} Try again when it has finished.`);
      return 0;
    }
    throw error;
  }
}

function runStatus(args: ParsedArgs): number {
  let db: DB;
  try {
    db = openDatabase(CONFIG.databaseFile, { readonly: true });
  } catch (error) {
    if (error instanceof DatabaseMissingError) {
      console.log(`No database yet at ${error.path}. Build it with: node ${process.argv[1]} sweep`);
      return 1;
    }
    if (error instanceof DatabaseOutdatedError) {
      console.log(`${error.message} Upgrade it with: node ${process.argv[1]} sweep`);
      return 1;
    }
    throw error;
  }
  try {
    const counts = db
      .prepare(
        `SELECT count(*) AS sessions, sum(source = 'codex') AS codex, sum(is_subagent) AS subagents, sum(legacy) AS legacy
         FROM sessions`
      )
      .get() as { sessions: number; codex: number | null; subagents: number | null; legacy: number | null };
    // Per source, leaving out Codex and pi sessions with no messages (Codex guardian-review threads); every Claude
    // session counts. Unlike list_projects, these counts include subagent runs. The headline total is the sum of
    // them, so the two always add up.
    const sourceRows = db.prepare(
      "SELECT source, count(*) AS n FROM sessions WHERE source = 'claude' OR message_count > 0 GROUP BY source"
    ).all() as Array<{ source: string; n: number }>;
    const sessionsBySource = SOURCES.map((source) => ({ source, sessions: sourceRows.find((r) => r.source === source)?.n ?? 0 }));
    const messages = db.prepare("SELECT count(*) AS messages, min(ts) AS oldest, max(ts) AS newest FROM messages").get() as
      { messages: number; oldest: number | null; newest: number | null };
    const { all, changed } = changedTranscripts(db);
    let size = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        size += statSync(CONFIG.databaseFile + suffix).size;
      } catch {
        // no WAL
      }
    }
    const lastSweep = Number(getMeta(db, "last_sweep") ?? 0) || null;
    const lastStats = getMeta(db, "last_sweep_stats");
    const status = {
      database: CONFIG.databaseFile,
      bytes: size,
      sessions: sessionsBySource.reduce((total, c) => total + c.sessions, 0),
      sessionsBySource,
      // As before: every Codex session, empty ones included (kept for scripts reading the old field).
      codexSessions: counts.codex ?? 0,
      subagentSessions: counts.subagents ?? 0,
      archivedSessions: counts.legacy ?? 0,
      messages: messages.messages,
      oldestMessage: messages.oldest,
      newestMessage: messages.newest,
      transcripts: all,
      filesBehind: changed.length,
      lastSweep,
      lastSweepMs: lastStats ? (JSON.parse(lastStats) as SweepStats).ms : null,
      legacyImport: getMeta(db, "legacy_import") ? JSON.parse(getMeta(db, "legacy_import") as string) : null,
    };
    if (args.flags.has("json")) {
      console.log(JSON.stringify(status));
      return 0;
    }
    const hostRows = db.prepare("SELECT host, count(*) AS n FROM sessions GROUP BY host ORDER BY n DESC, host").all() as
      Array<{ host: string; n: number }>;
    const hostsLine = hostRows.some((r) => r.host !== "")
      ? [`Hosts: ${hostRows.map((r) => (r.host ? `${r.host} (${n(r.n)} sessions)` : `unknown (${n(r.n)})`)).join(", ")}`]
      : [];
    console.log(
      [
        `Database: ${status.database} (${bytes(status.bytes)})`,
        `Sessions: ${n(status.sessions)} (${SOURCES.map((s) => `${n(sessionsOf(status.sessionsBySource, s))} ${SOURCE_LABELS[s]}`).join(", ")}, ${n(status.subagentSessions)} subagent runs, ${n(status.archivedSessions)} archived from the old index)`,
        ...hostsLine,
        `Messages: ${n(status.messages)}, oldest ${formatDateTime(status.oldestMessage)}, newest ${formatDateTime(status.newestMessage)}`,
        `Files behind: ${n(status.filesBehind)} of ${n(status.transcripts)} transcripts changed since they were indexed`,
        `Last sweep: ${lastSweep ? `${formatDateTime(lastSweep)}${status.lastSweepMs !== null ? ` (took ${(status.lastSweepMs / 1000).toFixed(1)} s)` : ""}` : "never"}`,
      ].join("\n")
    );
    return 0;
  } finally {
    db.close();
  }
}

function sessionsOf(counts: Array<{ source: Source; sessions: number }>, source: Source): number {
  return counts.find((c) => c.source === source)?.sessions ?? 0;
}

/** The old index unpacks to several GB: make sure this process may use that much. */
const IMPORT_HEAP_MB = 24_576;

async function runImportLegacy(args: ParsedArgs): Promise<number> {
  if (getHeapStatistics().heap_size_limit < (IMPORT_HEAP_MB / 2) * 1024 * 1024 && !process.env.CLAUDE_HISTORY_IMPORT_CHILD) {
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, `--max-old-space-size=${IMPORT_HEAP_MB}`, process.argv[1], ...process.argv.slice(2)],
      { stdio: "inherit", env: { ...process.env, CLAUDE_HISTORY_IMPORT_CHILD: "1" } }
    );
    return child.status ?? 1;
  }
  const db = openDatabase(CONFIG.databaseFile, { create: true });
  try {
    const stats = await importLegacy(db);
    console.log(
      args.flags.has("json")
        ? JSON.stringify(stats)
        : `Imported ${n(stats.sessionsImported)} sessions (${n(stats.rowsImported)} chunks) from the old index ` +
          `(${n(stats.sessionsSkippedOnDisk)} still have transcripts, ${n(stats.sessionsSkippedExisting)} already in the database), ` +
          `${n(stats.summariesImported)} summaries and ${n(stats.knowledgeImported)} knowledge entries in ${(stats.ms / 1000).toFixed(1)} s.`
    );
    return 0;
  } finally {
    db.close();
  }
}

function runSearch(args: ParsedArgs): number {
  const query = args.positional.join(" ");
  const t0 = performance.now();
  let db: DB;
  try {
    db = openDatabase(CONFIG.databaseFile);
  } catch (error) {
    if (error instanceof DatabaseMissingError) {
      console.log(`No database yet at ${error.path}. Build it with: node ${process.argv[1]} sweep`);
      return 1;
    }
    throw error;
  }
  try {
    const opened = performance.now();
    const top = args.flags.has("no-topup") ? null : topUp(db);
    const toppedUp = performance.now();
    const freshness = top && top.behind > 0 ? `index: ${top.behind} changed transcripts not yet indexed` : undefined;
    const sort = args.flags.get("sort");
    const limit = Number(args.flags.get("limit"));
    const text = handleSearchHistory(
      new SearchEngine(db),
      {
        query,
        project: typeof args.flags.get("project") === "string" ? (args.flags.get("project") as string) : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        include_context: args.flags.has("context"),
        sort: sort === "recent" || sort === "relevance" ? (sort as SortOrder) : undefined,
      },
      { currentProject: encodeProjectPath(process.cwd()), freshness }
    );
    const searched = performance.now();
    console.log(text);
    if (args.flags.has("timing")) {
      const ms = (a: number, b: number) => `${(b - a).toFixed(1)} ms`;
      console.log(
        `\ntiming: open ${ms(t0, opened)}, top-up ${ms(opened, toppedUp)}${top ? ` (${top.indexed} indexed, ${top.behind} behind)` : " (off)"}, ` +
          `search ${ms(toppedUp, searched)}, total ${ms(t0, searched)}`
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

const HELP = `claude-history-mcp: search past Claude Code, Codex and pi conversations.

  node dist/index.js                    run the MCP server (stdio)
  node dist/index.js sweep [--json]     index what changed, refresh summaries (alias: index)
  node dist/index.js rebuild [--json]   build a fresh database and swap it in, keeping archived sessions
  node dist/index.js status [--json]    database size, counts, files behind, last sweep
  node dist/index.js import-legacy      one-time import of the old index.msgpack, summaries/ and knowledge.json
  node dist/index.js record-repo [dir]  note which git repository a directory belongs to (prints nothing)
  node dist/index.js search "<query>" [--limit N] [--project P] [--context] [--sort recent] [--timing] [--no-topup]

Environment: CLAUDE_HISTORY_DATA_DIR, CLAUDE_HISTORY_CLAUDE_DIR, CLAUDE_HISTORY_PROJECTS_DIR,
CODEX_TRANSCRIPT_FEED, CLAUDE_HISTORY_CODEX_SESSIONS_DIR, CLAUDE_HISTORY_PI_SESSIONS_DIR, CODEX_HOME,
CLAUDE_HISTORY_TOPUP_MS.`;

export async function runCommand(command: string, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (command) {
      case "sweep":
      case "index":
        return runSweep(args);
      case "rebuild":
        return await runRebuild(args);
      case "status":
        return runStatus(args);
      case "import-legacy":
        return await runImportLegacy(args);
      case "search":
        return runSearch(args);
      case "record-repo":
        // Runs at every session start: silent, never fails, and never opens the database.
        try {
          recordRepos([args.positional[0] ?? process.cwd()]);
        } catch {
          // process.cwd() throws when the directory was deleted: nothing to record
        }
        return 0;
      default:
        console.log(HELP);
        return 0;
    }
  } catch (error) {
    console.error(`${command} failed: ${(error as Error).message}`);
    return 1;
  }
}
