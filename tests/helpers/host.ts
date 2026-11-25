import { afterEach, beforeEach } from 'vitest';

/** Name this machine `name` (CLAUDE_HISTORY_HOST) for the tests in the enclosing describe, then restore it. */
export function useHost(name = 'laptop'): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CLAUDE_HISTORY_HOST;
    process.env.CLAUDE_HISTORY_HOST = name;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_HISTORY_HOST;
    else process.env.CLAUDE_HISTORY_HOST = saved;
  });
}
