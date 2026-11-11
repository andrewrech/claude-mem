import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProjectAllowed } from '../../src/utils/project-filter.js';

let home: string;
let root: string;
let other: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cmem-project-inclusion-'));
  root = join(home, 'chosen'); other = join(home, 'chosen-other');
  mkdirSync(join(root, 'subdir'), { recursive: true }); mkdirSync(other);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('canonical project opt-in', () => {
  it('preserves upstream behavior when unset, while explicit [] selects nothing', () => {
    expect(isProjectAllowed('/nonexistent/legacy', '', '')).toBe(true);
    expect(isProjectAllowed(undefined, '', '')).toBe(true);
    expect(isProjectAllowed(root, '', '[]')).toBe(false);
    expect(isProjectAllowed(undefined, '', '[]')).toBe(false);
  });
  it('allows the chosen root and descendants but not siblings or ancestors', () => {
    const list = JSON.stringify([root]);
    expect(isProjectAllowed(root, '', list)).toBe(true);
    expect(isProjectAllowed(join(root, 'subdir'), '', list)).toBe(true);
    expect(isProjectAllowed(other, '', list)).toBe(false);
    expect(isProjectAllowed(home, '', list)).toBe(false);
  });
  it('resolves authorized aliases and refuses an escaping symlink below the root', () => {
    const alias = join(home, 'case-finding');
    symlinkSync(root, alias); symlinkSync(other, join(root, 'escape'));
    expect(isProjectAllowed(alias, '', JSON.stringify([root]))).toBe(true);
    expect(isProjectAllowed(root, '', JSON.stringify([alias]))).toBe(true);
    expect(isProjectAllowed(join(root, 'escape'), '', JSON.stringify([root]))).toBe(false);
    expect(isProjectAllowed(alias, realpathSync(root) + '/**', JSON.stringify([alias]))).toBe(false);
    expect(isProjectAllowed(alias, alias + '/**', JSON.stringify([root]))).toBe(false);
  });
  it('fails closed for malformed lists, unresolved roots, and missing checkout evidence', () => {
    for (const policy of ['{', '{}', 'null', '["relative"]', '[42]', null, 42, JSON.stringify([join(home, 'missing')])]) {
      expect(isProjectAllowed(root, '', policy)).toBe(false);
    }
    for (const cwd of [undefined, null, '', 'chosen', join(home, 'missing')]) {
      expect(isProjectAllowed(cwd, '', JSON.stringify([root]))).toBe(false);
    }
    const file = join(root, 'file.txt'); writeFileSync(file, 'not a directory');
    expect(isProjectAllowed(file, '', JSON.stringify([root]))).toBe(false);
    expect(isProjectAllowed(root, '', JSON.stringify([file]))).toBe(false);
  });
  it('applies removal on the next decision without a cached root list', () => {
    expect(isProjectAllowed(root, '', JSON.stringify([root]))).toBe(true);
    expect(isProjectAllowed(root, '', JSON.stringify([other]))).toBe(false);
    expect(isProjectAllowed(root, '', JSON.stringify([root]))).toBe(true);
  });
});
