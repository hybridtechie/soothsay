import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepo } from '../src/repo/scanner.js';
import { loadConfig } from '../src/config.js';
import { loadProject, runChecks } from '../src/engine.js';
import { linkValid } from '../src/checks/linkValid.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'soothsay-scan-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      packageManager: 'pnpm@9.1.0',
      scripts: { test: 'vitest run', build: 'tsc' },
    }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(join(root, 'scripts', 'Sync.py'), 'print("hi")\n');
  writeFileSync(join(root, 'CLAUDE.md'), '# rules\n');
  writeFileSync(join(root, 'node_modules', 'junk', 'x.md'), 'ignore me\n');
  mkdirSync(join(root, 'brain', 'inbox'), { recursive: true }); // empty dirs
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'index.js'), 'export {};\n');
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build', 'out.txt'), 'x\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scanRepo', () => {
  it('collects repo-relative files, excluding ignores', async () => {
    const repo = await scanRepo(root);
    expect(repo.files.has('CLAUDE.md')).toBe(true);
    expect(repo.files.has('scripts/Sync.py')).toBe(true);
    expect([...repo.files].some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('includes committed dist/ and build/ artifacts in facts (only node_modules/.git excluded)', async () => {
    const repo = await scanRepo(root);
    expect(repo.files.has('dist/index.js')).toBe(true);
    expect(repo.files.has('build/out.txt')).toBe(true);
    expect(repo.dirs.has('dist')).toBe(true);
  });

  it('collects directories, including empty ones, excluding ignores', async () => {
    const repo = await scanRepo(root);
    expect(repo.dirs.has('scripts')).toBe(true);
    expect(repo.dirs.has('brain')).toBe(true);
    expect(repo.dirs.has('brain/inbox')).toBe(true);
    expect([...repo.dirs].some((d) => d.startsWith('node_modules/'))).toBe(false);
  });

  it('maps lowercase paths for case-mismatch detection', async () => {
    const repo = await scanRepo(root);
    expect(repo.filesLower.get('scripts/sync.py')).toBe('scripts/Sync.py');
  });

  it('reads package.json scripts and packageManager field', async () => {
    const repo = await scanRepo(root);
    expect(repo.packageScripts.has('test')).toBe(true);
    expect(repo.packageScripts.has('build')).toBe(true);
    expect(repo.packageManager).toBe('pnpm');
    expect(repo.packageManagerSource).toBe('package.json#packageManager');
    expect(repo.lockfiles).toEqual(['pnpm-lock.yaml']);
  });

  it('falls back to lockfile inference when packageManager is absent', async () => {
    const alt = mkdtempSync(join(tmpdir(), 'soothsay-alt-'));
    writeFileSync(join(alt, 'yarn.lock'), '');
    writeFileSync(join(alt, 'package.json'), JSON.stringify({ name: 'x' }));
    const repo = await scanRepo(alt);
    expect(repo.packageManager).toBe('yarn');
    expect(repo.packageManagerSource).toBe('yarn.lock');
    rmSync(alt, { recursive: true, force: true });
  });

  it('returns null package manager when ambiguous or unknown', async () => {
    const alt = mkdtempSync(join(tmpdir(), 'soothsay-amb-'));
    writeFileSync(join(alt, 'yarn.lock'), '');
    writeFileSync(join(alt, 'package-lock.json'), '{}');
    const repo = await scanRepo(alt);
    expect(repo.packageManager).toBeNull();
    rmSync(alt, { recursive: true, force: true });
  });
});

describe('loadProject: doc-scan ignores vs repo facts', () => {
  it('facts keep dist/ and user-ignored files, while doc selection excludes them', async () => {
    const alt = mkdtempSync(join(tmpdir(), 'soothsay-split-'));
    mkdirSync(join(alt, 'dist'), { recursive: true });
    mkdirSync(join(alt, 'stuff'), { recursive: true });
    writeFileSync(join(alt, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(join(alt, 'dist', 'SKILL.md'), '---\nname: x\ndescription: y\n---\n# X\n');
    writeFileSync(join(alt, 'stuff', 'SKILL.md'), '# data\n');
    writeFileSync(join(alt, 'soothsay.yml'), 'ignore: ["stuff/**"]\n');
    writeFileSync(join(alt, 'README.md'), 'See [bundle](dist/index.js) and [data](stuff/SKILL.md).\n');

    const ctx = await loadProject(alt);
    // Docs: dist/SKILL.md and stuff/SKILL.md are NOT scanned as docs.
    expect(ctx.docs.map((d) => d.path)).toEqual(['README.md']);
    // Facts: committed dist/ and user-ignored files ARE known to the repo.
    expect(ctx.repo.files.has('dist/index.js')).toBe(true);
    expect(ctx.repo.files.has('stuff/SKILL.md')).toBe(true);
    // So links to them are not false broken-link errors.
    const findings = await runChecks(ctx, [linkValid]);
    expect(findings).toEqual([]);
    rmSync(alt, { recursive: true, force: true });
  });
});

describe('loadConfig', () => {
  it('returns defaults when no soothsay.yml exists', () => {
    const cfg = loadConfig(root);
    expect(cfg.docs.length).toBeGreaterThan(0);
    expect(cfg.asserts).toEqual([]);
    expect(cfg.disable).toEqual([]);
  });

  it('merges soothsay.yml over defaults', () => {
    writeFileSync(
      join(root, 'soothsay.yml'),
      [
        'docs:',
        '  - CLAUDE.md',
        'disable:',
        '  - link-valid',
        'asserts:',
        '  - id: pm',
        '    forbid_command: ["npm install"]',
      ].join('\n'),
    );
    const cfg = loadConfig(root);
    expect(cfg.docs).toEqual(['CLAUDE.md']);
    expect(cfg.disable).toEqual(['link-valid']);
    expect(cfg.asserts[0]?.id).toBe('pm');
    rmSync(join(root, 'soothsay.yml'));
  });
});
