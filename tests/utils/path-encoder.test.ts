import { describe, expect, it } from 'vitest';
import { claudeProjectDir, encodeProjectPath, UNKNOWN_PROJECT } from '../../src/utils/path-encoder.js';

describe('claudeProjectDir', () => {
  it('replaces every character outside [A-Za-z0-9] with a dash', () => {
    expect(claudeProjectDir('/home/simon/.claude')).toBe('-home-simon--claude');
    expect(claudeProjectDir('/mnt/bulk/Github/my_proj')).toBe('-mnt-bulk-Github-my-proj');
  });

  it('ignores a trailing slash', () => {
    expect(claudeProjectDir('/work/app/')).toBe('-work-app');
  });

  it('leaves encodeProjectPath unchanged', () => {
    expect(encodeProjectPath('/home/simon/.claude')).toBe('-home-simon-.claude');
  });

  it('names the unknown placeholder', () => {
    expect(UNKNOWN_PROJECT).toBe('-unknown');
  });
});
