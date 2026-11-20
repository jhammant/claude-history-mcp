import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { indexFile } from '../../src/indexing/indexer.js';
import { sweep } from '../../src/indexing/sweep.js';
import { openDatabase } from '../../src/db/database.js';
import {
  assistantText, assistantThinking, codexLine, createCorpus, toolResult, toolUse, userLine, type Corpus,
} from '../helpers/corpus.js';

type Row = { seq: number; role: string; prose: string; tool_input: string; tool_output: string; tools: string };

describe('incremental indexing by byte offset', () => {
  let corpus: Corpus;
  const rows = (sessionId: string): Row[] =>
    corpus.open().prepare(
      `SELECT m.seq, m.role, t.prose, t.tool_input, t.tool_output, m.tools FROM messages m
       JOIN message_text t ON t.id = m.id JOIN sessions s ON s.sid = m.session_sid WHERE s.id = ? ORDER BY m.seq`,
    ).all(sessionId) as Row[];
  const offset = (path: string) =>
    (corpus.open().prepare('SELECT offset FROM files WHERE path = ?').get(path) as { offset: number }).offset;
  const ftsCount = (word: string) =>
    (corpus.open().prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(word) as { n: number }).n;

  beforeEach(() => { corpus = createCorpus(); });
  afterEach(() => corpus.cleanup());

  it('indexes only the appended lines when a file grows', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's1'), [userLine('first question about kafka')]);
    indexFile(corpus.open(), corpus.file(path));
    corpus.append(path, [userLine('second question about zookeeper')]);

    // Act
    const result = indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(result.status).toBe('indexed');
    expect(result.messagesAdded).toBe(1);
    expect(rows('s1').map((r) => r.prose)).toEqual(['first question about kafka', 'second question about zookeeper']);
    expect(ftsCount('kafka')).toBe(1);
  });

  it('leaves a partial last line for later and picks it up once it is complete', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's2'), [userLine('complete line')]);
    const half = JSON.stringify(userLine('the unfinished line about raft'));
    corpus.appendRaw(path, half.slice(0, 30));

    // Act
    indexFile(corpus.open(), corpus.file(path));
    const afterHalf = rows('s2').length;
    const stoppedAt = offset(path);
    corpus.appendRaw(path, half.slice(30) + '\n');
    indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(afterHalf).toBe(1);
    expect(stoppedAt).toBe(JSON.stringify(userLine('complete line')).length + 1);
    expect(rows('s2').map((r) => r.prose)).toEqual(['complete line', 'the unfinished line about raft']);
  });

  it('re-reads a truncated file from zero without leaving stale matches', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's3'), [userLine('zebra crossings'), userLine('traffic lights')]);
    indexFile(corpus.open(), corpus.file(path));
    truncateSync(path, 0);
    corpus.append(path, [userLine('pelican')]);

    // Act
    const result = indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(result.reset).toBe(true);
    expect(rows('s3').map((r) => r.prose)).toEqual(['pelican']);
    expect(ftsCount('zebra')).toBe(0);
  });

  it('re-reads a file replaced by a different one of greater size', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's4'), [userLine('original opening words')]);
    indexFile(corpus.open(), corpus.file(path));
    const replacement = join(corpus.root, 'replacement.jsonl');
    writeFileSync(replacement, [userLine('rewritten opening words, longer than before'), userLine('and more')]
      .map((l) => JSON.stringify(l) + '\n').join(''));
    renameSync(replacement, path);

    // Act
    const result = indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(result.reset).toBe(true);
    expect(rows('s4').map((r) => r.prose)).toEqual(['rewritten opening words, longer than before', 'and more']);
  });

  it('spots a file rewritten in place (same inode, more bytes) by its first bytes', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's5'), [userLine('alpha')]);
    indexFile(corpus.open(), corpus.file(path));
    writeFileSync(path, [userLine('omega'), userLine('beta')].map((l) => JSON.stringify(l) + '\n').join(''));

    // Act
    const result = indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(result.reset).toBe(true);
    expect(rows('s5').map((r) => r.prose)).toEqual(['omega', 'beta']);
  });

  it('drops a batch when another indexer committed those bytes first, so nothing is duplicated', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's6'), [userLine('one'), userLine('two'), userLine('three')]);
    const db = corpus.open();
    const other = openDatabase(join(corpus.dataDir, 'history.db'));
    let raced = false;

    // Act: the other connection indexes the file between our read and our commit
    const result = indexFile(db, corpus.file(path), {
      beforeCommit: () => {
        if (raced) return;
        raced = true;
        indexFile(other, corpus.file(path));
      },
    });
    other.close();

    // Assert
    expect(result.status).toBe('raced');
    expect(rows('s6').map((r) => r.prose)).toEqual(['one', 'two', 'three']);
  });

  it('two processes indexing the same file at once store each message once', async () => {
    // Arrange
    const lines = Array.from({ length: 400 }, (_, i) => userLine(`message number ${i} about consensus`));
    const path = corpus.write(corpus.sessionPath('-work-app', 's7'), lines);
    corpus.open(); // create the schema first
    const script = [
      "import { indexFile } from './src/indexing/indexer.ts';",
      "import { openDatabase } from './src/db/database.ts';",
      "import { listTranscripts } from './src/parsers/transcript-files.ts';",
      "const db = openDatabase(process.env.CLAUDE_HISTORY_DATA_DIR + '/history.db');",
      "const file = listTranscripts().find((f) => f.path === process.argv[1]);",
      "console.log(JSON.stringify(indexFile(db, file, { batchBytes: 2048 })));",
    ].join('\n');
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], {
        cwd: process.cwd(), env: process.env,
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
    });

    // Act
    await Promise.all([run(), run()]);

    // Assert
    const stored = rows('s7');
    expect(stored).toHaveLength(400);
    expect(new Set(stored.map((r) => r.prose)).size).toBe(400);
  }, 30_000);

  it('keeps a session after its transcript file is deleted', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's8'), [userLine('remember the eviction policy')]);
    indexFile(corpus.open(), corpus.file(path));
    rmSync(path);

    // Act
    const stats = sweep(corpus.open());

    // Assert
    expect(stats.transcripts).toBe(0);
    expect(rows('s8').map((r) => r.prose)).toEqual(['remember the eviction policy']);
  });

  it('makes one row per assistant turn, with its tool calls and their results in both shapes', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's9'), [
      userLine('run the tests'),
      assistantThinking('private reasoning about flakiness', { id: 'm1' }),
      assistantText('Running them now.', { id: 'm1' }),
      toolUse('Bash', { command: 'npm test -- --grep retry' }, { id: 'm1', toolUseId: 't1' }),
      toolUse('Read', { file_path: '/work/app/src/retry.ts' }, { id: 'm1', toolUseId: 't2' }),
      toolResult('3 passing, 1 failing: RetryPolicy backoff', { toolUseId: 't1' }),
      toolResult([{ type: 'text', text: 'export class RetryPolicy {}' }, { type: 'image', source: { data: 'AAAA' } }], { toolUseId: 't2' }),
      assistantText('One test fails.', { id: 'm2' }),
    ]);

    // Act
    indexFile(corpus.open(), corpus.file(path));

    // Assert
    const stored = rows('s9');
    expect(stored.map((r) => r.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(stored[1].prose).toBe('Running them now.');
    expect(stored[1].tools).toBe('Bash Read');
    expect(stored[1].tool_input).toContain('Bash: npm test -- --grep retry');
    expect(stored[1].tool_input).toContain('Read: /work/app/src/retry.ts');
    expect(stored[1].tool_output).toContain('RetryPolicy backoff');
    expect(stored[1].tool_output).toContain('export class RetryPolicy');
    expect(stored.map((r) => r.prose).join(' ')).not.toContain('private reasoning');
  });

  it('extends the open assistant turn when its tool result arrives in a later append', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's10'), [
      userLine('check disk'),
      toolUse('Bash', { command: 'df -h' }, { id: 'm1', toolUseId: 't1' }),
    ]);
    indexFile(corpus.open(), corpus.file(path));
    corpus.append(path, [toolResult('/dev/disk3 91% used', { toolUseId: 't1' })]);

    // Act
    indexFile(corpus.open(), corpus.file(path));

    // Assert
    const stored = rows('s10');
    expect(stored).toHaveLength(2);
    expect(stored[1].tool_output).toBe('/dev/disk3 91% used');
    expect(ftsCount('disk3')).toBe(1);
  });

  it('caps long tool results and drops base64 blobs', () => {
    // Arrange
    const blob = 'iVBORw0KGgo' + 'A'.repeat(5000);
    const path = corpus.write(corpus.sessionPath('-work-app', 's11'), [
      toolUse('Bash', { command: 'cat big.log' }, { id: 'm1' }),
      toolResult('start ' + 'line of log output\n'.repeat(1000) + ' end'),
      toolUse('Read', { file_path: 'img.png' }, { id: 'm2' }),
      toolResult(`image data ${blob}`),
    ]);

    // Act
    indexFile(corpus.open(), corpus.file(path));

    // Assert
    const stored = rows('s11');
    expect(stored[0].tool_output.length).toBeLessThanOrEqual(2000);
    expect(stored[0].tool_output.startsWith('start')).toBe(true);
    expect(stored[1].tool_output).toBe('image data [binary]');
  });

  it('skips injected meta messages and strips system reminders', () => {
    // Arrange
    const path = corpus.write(corpus.sessionPath('-work-app', 's12'), [
      userLine('Base directory for this skill: lots of skill text', { isMeta: true }),
      userLine('real question <system-reminder>hidden instructions</system-reminder> here'),
    ]);

    // Act
    indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(rows('s12').map((r) => r.prose)).toEqual(['real question  here']);
  });

  it('indexes subagent transcripts, flagged and linked to their parent session', () => {
    // Arrange
    corpus.write(corpus.sessionPath('-work-app', 'parent-1'), [userLine('spawn a helper')]);
    const sub = corpus.write(corpus.subagentPath('-work-app', 'parent-1', 'abc123', 'workflows/wf_1'),
      [userLine('helper prompt: audit the cache', { sessionId: 'parent-1' })]);
    writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Audit cache' }));

    // Act
    indexFile(corpus.open(), corpus.file(sub));

    // Assert
    const session = corpus.open().prepare('SELECT * FROM sessions WHERE id = ?').get('agent-abc123@parent-1') as Record<string, unknown>;
    expect(session.is_subagent).toBe(1);
    expect(session.parent_session).toBe('parent-1');
    expect(session.title).toBe('Explore: Audit cache');
    expect(rows('agent-abc123@parent-1')[0].prose).toBe('helper prompt: audit the cache');
  });

  it('indexes Codex feed transcripts with their source', () => {
    // Arrange
    const path = corpus.write(corpus.codexPath('-work-codex-api', 'codex-0001'), [
      codexLine('user', 'Resolve backpressure in the bounded queue', { sessionId: 'codex-0001', cwd: '/work/codex-api' }),
      codexLine('assistant', 'Added a semaphore.', { sessionId: 'codex-0001', cwd: '/work/codex-api' }),
    ]);

    // Act
    indexFile(corpus.open(), corpus.file(path));

    // Assert
    const session = corpus.open().prepare('SELECT source, cwd, message_count, first_prompt FROM sessions WHERE id = ?')
      .get('codex-0001');
    expect(session).toEqual({ source: 'codex', cwd: '/work/codex-api', message_count: 2,
      first_prompt: 'Resolve backpressure in the bounded queue' });
  });

  it('stops at the deadline and finishes on the next call', () => {
    // Arrange
    const lines = Array.from({ length: 50 }, (_, i) => userLine(`line ${i} `.padEnd(400, 'x')));
    const path = corpus.write(corpus.sessionPath('-work-app', 's13'), lines);

    // Act
    const first = indexFile(corpus.open(), corpus.file(path), { batchBytes: 1024, deadline: Date.now() - 1 });
    const second = indexFile(corpus.open(), corpus.file(path));

    // Assert
    expect(first.complete).toBe(false);
    expect(first.messagesAdded).toBeGreaterThan(0);
    expect(first.messagesAdded + second.messagesAdded).toBe(50);
    expect(rows('s13')).toHaveLength(50);
  });
});
