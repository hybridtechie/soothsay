import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterIgnored } from '../src/repo/ignored.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'soothsay-ignored-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(
    join(root, '.gitignore'),
    ['token.json', '.venv/', 'archive/emails/', '*.log'].join('\n') + '\n',
  );
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'kept.ts'), 'export {};\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('filterIgnored', () => {
  it('returns the subset of paths that git ignores', () => {
    const out = filterIgnored(root, ['token.json', 'src/kept.ts', 'debug.log']);
    expect(out.has('token.json')).toBe(true);
    expect(out.has('debug.log')).toBe(true);
    expect(out.has('src/kept.ts')).toBe(false);
  });

  it('matches dir-only patterns for nonexistent paths via the trailing-slash form', () => {
    // `archive/emails/` (dir-only pattern) does not match the bare query
    // `archive/emails` when nothing exists on disk — both the as-given and
    // slash-appended forms must be queried.
    const out = filterIgnored(root, [
      'archive/emails/',
      'archive/emails/foo.txt',
      'src/kept.ts',
    ]);
    expect(out.has('archive/emails/')).toBe(true);
    expect(out.has('archive/emails/foo.txt')).toBe(true);
    expect(out.has('src/kept.ts')).toBe(false);
  });

  it('handles the none-ignored case (git exit code 1) gracefully', () => {
    const out = filterIgnored(root, ['src/kept.ts', 'also/fine.md']);
    expect(out.size).toBe(0);
  });

  it('returns an empty set for an empty input', () => {
    expect(filterIgnored(root, []).size).toBe(0);
  });

  it('returns an empty set when the root is not a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'soothsay-nogit-'));
    try {
      expect(filterIgnored(plain, ['token.json']).size).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns an empty set when the root does not exist', () => {
    expect(filterIgnored('/no/such/dir/anywhere', ['a.md']).size).toBe(0);
  });
});
