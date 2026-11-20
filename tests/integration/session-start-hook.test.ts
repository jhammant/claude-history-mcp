import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDatabase, type DB } from '../../src/db/database.js';

describe('session-start hook output', () => {
  let root: string;
  let db: DB | undefined;
  const savedDataDir = process.env.CLAUDE_HISTORY_DATA_DIR;

  const database = () => (db ??= openDatabase(join(root, 'history.db'), { create: true }));
  const addSummary = (sessionId: string, project: string, topic: string, endTime: number) =>
    database().prepare('INSERT INTO summaries(session_id, project, end_time, data) VALUES (?, ?, ?, ?)')
      .run(sessionId, project, endTime, JSON.stringify({ sessionId, project, endTime, topic }));
  const addKnowledge = (type: string, project: string, summary: string) =>
    database().prepare('INSERT INTO knowledge(type, project, session_id, ts, summary) VALUES (?, ?, ?, ?, ?)')
      .run(type, project, 's', Date.now(), summary);
  const runHook = async () => {
    db?.close();
    db = undefined;
    await import('../../src/hooks/session-start-hook.js');
  };

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'history-session-start-'));
    process.env.CLAUDE_HISTORY_DATA_DIR = root;
    vi.spyOn(process, 'cwd').mockReturnValue('/work/hook-project');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
    db = undefined;
    if (savedDataDir === undefined) delete process.env.CLAUDE_HISTORY_DATA_DIR;
    else process.env.CLAUDE_HISTORY_DATA_DIR = savedDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  it('emits one JSON object with session context instead of a bracket-prefixed text line', async () => {
    // Arrange
    addSummary('recent', '-work-hook-project', 'Fixed startup hooks', Date.now());
    addSummary('other', '-work-other-project', 'Unrelated work', Date.now());

    // Act
    await runHook();

    // Assert
    expect(console.log).toHaveBeenCalledOnce();
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      '[ClaudeHistory] Previous context for hook-project:\n- Last session (today): Fixed startup hooks'
    );
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Unrelated');
  });

  it('shows the three newest sessions and the newest decisions, solutions and fix', async () => {
    // Arrange
    for (let i = 0; i < 5; i++) addSummary(`s${i}`, '-work-hook-project', `topic ${i}`, Date.now() - i * 86_400_000);
    addKnowledge('decision', '-work-hook-project', 'Use WAL mode');
    addKnowledge('solution', '-work-hook-project', 'Raise the busy timeout');
    addKnowledge('error_fix', '-work-hook-project', 'SQLITE_BUSY → retry');

    // Act
    await runHook();

    // Assert
    const context: string = JSON.parse(vi.mocked(console.log).mock.calls[0][0]).hookSpecificOutput.additionalContext;
    expect(context.split('\n')).toEqual([
      '[ClaudeHistory] Previous context for hook-project:',
      '- Last session (today): topic 0',
      '- Last session (yesterday): topic 1',
      '- Last session (2 days ago): topic 2',
      '- Key decision: Use WAL mode',
      '- Solution found: Raise the busy timeout',
      '- Error fix: SQLITE_BUSY → retry',
    ]);
  });

  it('preserves quotes and newlines in knowledge-only context', async () => {
    // Arrange
    const decision = 'Use "JSON"\nfor hook output';
    addKnowledge('decision', '-work-hook-project', decision);

    // Act
    await runHook();

    // Assert
    expect(console.log).toHaveBeenCalledOnce();
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
    expect(output.hookSpecificOutput.additionalContext).toContain(`- Key decision: ${decision}`);
  });

  it('emits nothing when no project context is available', async () => {
    // Arrange
    addSummary('other', '-work-other-project', 'Unrelated work', Date.now());

    // Act
    await runHook();

    // Assert
    expect(console.log).not.toHaveBeenCalled();
  });

  it('emits nothing and does not throw when the database is missing', async () => {
    await expect(runHook()).resolves.toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('emits nothing and does not throw when the database is locked', async () => {
    // Arrange
    addSummary('recent', '-work-hook-project', 'Fixed startup hooks', Date.now());
    db?.close();
    db = undefined;
    const locker = new Database(join(root, 'history.db'));
    locker.pragma('locking_mode = EXCLUSIVE');
    locker.exec('BEGIN EXCLUSIVE');

    // Act
    try {
      await import('../../src/hooks/session-start-hook.js');
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }

    // Assert
    expect(console.log).not.toHaveBeenCalled();
  });
});
