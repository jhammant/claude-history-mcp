/**
 * Synthetic transcripts in a temp directory, and the environment that points the code
 * at them. Nothing here reads or writes real history.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { openDatabase, type DB } from '../../src/db/database.js';
import type { TranscriptFile } from '../../src/parsers/transcript-files.js';
import { listTranscripts } from '../../src/parsers/transcript-files.js';

const ENV_KEYS = ['CLAUDE_HISTORY_DATA_DIR', 'CLAUDE_HISTORY_PROJECTS_DIR', 'CLAUDE_HISTORY_CLAUDE_DIR',
  'CODEX_TRANSCRIPT_FEED', 'CODEX_HOME', 'CLAUDE_HISTORY_TOPUP_MS'] as const;

export interface Corpus {
  root: string;
  projects: string;
  codexFeed: string;
  dataDir: string;
  env: Record<string, string>;
  /** Path of a top-level Claude session transcript. */
  sessionPath(project: string, sessionId: string): string;
  subagentPath(project: string, parentId: string, agentId: string, nested?: string): string;
  codexPath(project: string, sessionId: string): string;
  write(path: string, lines: object[]): string;
  append(path: string, lines: object[]): void;
  /** Append raw text (e.g. half a line). */
  appendRaw(path: string, text: string): void;
  open(): DB;
  file(path: string): TranscriptFile;
  cleanup(): void;
}

export function createCorpus(): Corpus {
  const root = mkdtempSync(join(tmpdir(), 'history-test-'));
  const projects = join(root, 'claude', 'projects');
  const codexFeed = join(root, 'codex-feed');
  const dataDir = join(root, 'data');
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(codexFeed, 'projects'), { recursive: true });
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const env = {
    CLAUDE_HISTORY_DATA_DIR: dataDir,
    CLAUDE_HISTORY_PROJECTS_DIR: projects,
    CLAUDE_HISTORY_CLAUDE_DIR: join(root, 'claude'),
    CODEX_TRANSCRIPT_FEED: codexFeed,
    CLAUDE_HISTORY_TOPUP_MS: '300',
  };
  Object.assign(process.env, env);
  delete process.env.CODEX_HOME;
  const toText = (lines: object[]) => lines.map((l) => JSON.stringify(l) + '\n').join('');
  let db: DB | undefined;

  return {
    root, projects, codexFeed, dataDir, env,
    sessionPath: (project, sessionId) => join(projects, project, `${sessionId}.jsonl`),
    subagentPath: (project, parentId, agentId, nested) =>
      join(projects, project, parentId, 'subagents', ...(nested ? [nested] : []), `agent-${agentId}.jsonl`),
    codexPath: (project, sessionId) => join(codexFeed, 'projects', project, `${sessionId}.jsonl`),
    write(path, lines) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, toText(lines));
      return path;
    },
    append(path, lines) {
      appendFileSync(path, toText(lines));
    },
    appendRaw(path, text) {
      appendFileSync(path, text);
    },
    open() {
      db ??= openDatabase(join(dataDir, 'history.db'), { create: true });
      return db;
    },
    file(path) {
      const found = listTranscripts().find((f) => f.path === path);
      if (!found) throw new Error(`fixture transcript not found: ${path}`);
      return found;
    },
    cleanup() {
      db?.close();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ line builders

let clock = Date.parse('2026-10-01T09:00:00Z');
export function resetClock(iso = '2026-10-01T09:00:00Z'): void {
  clock = Date.parse(iso);
}
function nextTs(): string {
  clock += 60_000;
  return new Date(clock).toISOString();
}

interface Common {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
}

function common(opts: Common) {
  return {
    sessionId: opts.sessionId ?? 'fixture',
    cwd: opts.cwd ?? '/work/app',
    gitBranch: opts.gitBranch ?? 'main',
    timestamp: opts.timestamp ?? nextTs(),
  };
}

export function userLine(text: string, opts: Common & { isMeta?: boolean } = {}) {
  return { type: 'user', ...common(opts), ...(opts.isMeta ? { isMeta: true } : {}), message: { role: 'user', content: text } };
}

export function assistantText(text: string, opts: Common & { id?: string } = {}) {
  return { type: 'assistant', ...common(opts), message: { id: opts.id ?? `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text }] } };
}

export function assistantThinking(thinking: string, opts: Common & { id?: string } = {}) {
  return { type: 'assistant', ...common(opts), message: { id: opts.id ?? `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'thinking', thinking }] } };
}

export function toolUse(name: string, input: object, opts: Common & { id?: string; toolUseId?: string } = {}) {
  return {
    type: 'assistant', ...common(opts),
    message: { id: opts.id ?? `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'tool_use', id: opts.toolUseId ?? 'tu', name, input }] },
  };
}

export function toolResult(content: string | object[], opts: Common & { toolUseId?: string } = {}) {
  return {
    type: 'user', ...common(opts),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: opts.toolUseId ?? 'tu', content }] },
  };
}

export function codexLine(role: 'user' | 'assistant', text: string, opts: Common = {}) {
  return { type: role, source_provider: 'codex', ...common(opts), message: { role, content: text } };
}
