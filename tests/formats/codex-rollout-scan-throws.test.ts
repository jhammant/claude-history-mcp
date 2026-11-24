import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/formats/js-cell.js', () => ({ scanCell: () => { throw new Error('boom'); } }));

import { codexRolloutFormat } from '../../src/formats/codex-rollout.js';
import { createCorpus, rolloutCall, rolloutMeta, type Corpus } from '../helpers/corpus.js';

let corpus: Corpus;
beforeEach(() => { corpus = createCorpus(); });
afterEach(() => corpus.cleanup());

it('falls back to a plain exec call when the cell scanner throws', () => {
  const file = corpus.file(corpus.write(corpus.rolloutPath('2026-10-01', '0199aaaa-0000-7000-8000-000000000001'), [rolloutMeta('u')]));
  const tr = codexRolloutFormat.translator(file, false);
  const out = tr.translate(rolloutCall('exec', 'tools.exec_command({cmd: "ls"})', 'cell', { custom: true }) as Record<string, unknown>);
  expect(out).toHaveLength(1);
  expect((out[0].message as { content: Array<{ name: string; id: string }> }).content[0]).toMatchObject({ id: 'cell', name: 'exec' });
});
