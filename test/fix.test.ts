import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFixes, caseCorrectToken } from '../src/fix.js';
import { rewritePmCommand } from '../src/checks/packageManagerConsistent.js';
import { loadProject, runChecks } from '../src/engine.js';
import { allChecks } from '../src/checks/index.js';
import { parseMarkdown } from '../src/parser/markdown.js';
import { pathExists } from '../src/checks/pathExists.js';
import { packageManagerConsistent } from '../src/checks/packageManagerConsistent.js';
import type { CheckContext, DocFile, RepoFacts, SoothsayConfig } from '../src/types.js';

const config: SoothsayConfig = { docs: [], ignore: [], disable: [], asserts: [] };

function repoOf(files: string[], overrides: Partial<RepoFacts> = {}): RepoFacts {
  const filesLower = new Map<string, string>();
  for (const f of files) filesLower.set(f.toLowerCase(), f);
  return {
    root: '/fake',
    files: new Set(files),
    dirs: new Set(),
    filesLower,
    packageJson: null,
    packageScripts: new Set(),
    lockfiles: [],
    packageManager: null,
    packageManagerSource: null,
    ...overrides,
  };
}

function ctxOf(docs: DocFile[], repo: RepoFacts): CheckContext {
  return { repo, docs, config };
}

const roots: string[] = [];
function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'soothsay-fix-'));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('caseCorrectToken', () => {
  it('corrects a simple case mismatch', () => {
    expect(caseCorrectToken('Scripts/Sync.py', 'scripts/sync.py')).toBe('scripts/sync.py');
  });

  it('keeps ./ and ../ prefixes while correcting the tail', () => {
    expect(caseCorrectToken('./FORMS.md', 'forms.md')).toBe('./forms.md');
    expect(caseCorrectToken('../src/Foo.md', 'src/foo.md')).toBe('../src/foo.md');
  });

  it('corrects a doc-relative token against a repo-relative actual path', () => {
    // doc lives in docs/, token "Guide.md" resolved to docs/guide.md
    expect(caseCorrectToken('Guide.md', 'docs/guide.md')).toBe('guide.md');
  });

  it('returns null when the segments do not line up or nothing changes', () => {
    expect(caseCorrectToken('other/file.md', 'docs/guide.md')).toBeNull();
    expect(caseCorrectToken('docs/guide.md', 'docs/guide.md')).toBeNull();
  });
});

describe('rewritePmCommand', () => {
  it('maps plain installs to the declared manager', () => {
    expect(rewritePmCommand('npm install', 'pnpm')).toBe('pnpm install');
    expect(rewritePmCommand('yarn install', 'npm')).toBe('npm install');
    expect(rewritePmCommand('pnpm i', 'bun')).toBe('bun install');
  });

  it('maps npm ci to the frozen-lockfile equivalent', () => {
    expect(rewritePmCommand('npm ci', 'pnpm')).toBe('pnpm install --frozen-lockfile');
    expect(rewritePmCommand('npm ci', 'yarn')).toBe('yarn install --frozen-lockfile');
  });

  it('maps package additions with the right verb per manager', () => {
    expect(rewritePmCommand('npm install lodash', 'pnpm')).toBe('pnpm add lodash');
    expect(rewritePmCommand('yarn add lodash react', 'npm')).toBe('npm install lodash react');
    expect(rewritePmCommand('npm i -D vitest', 'pnpm')).toBe('pnpm add vitest -D');
    expect(rewritePmCommand('npm i -D vitest', 'bun')).toBe('bun add vitest --dev');
  });

  it('refuses to translate what it cannot translate faithfully', () => {
    expect(rewritePmCommand('npm install --legacy-peer-deps', 'pnpm')).toBeNull();
    expect(rewritePmCommand('npm ci --ignore-scripts', 'pnpm')).toBeNull();
    expect(rewritePmCommand('npm add', 'pnpm')).toBeNull();
    expect(rewritePmCommand('npm install -D', 'pnpm')).toBeNull();
  });
});

describe('fix emission on findings', () => {
  it('path-exists attaches a fix for case mismatches', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Run `Scripts/Sync.py` daily.\n');
    const findings = await pathExists.run(ctxOf([doc], repoOf(['scripts/sync.py'])));
    expect(findings[0]!.fix).toEqual({
      file: 'CLAUDE.md',
      line: 1,
      from: 'Scripts/Sync.py',
      to: 'scripts/sync.py',
    });
  });

  it('package-manager attaches a fix only for unambiguous violations', async () => {
    const repo = repoOf(['pnpm-lock.yaml'], {
      packageManager: 'pnpm',
      packageManagerSource: 'pnpm-lock.yaml',
    });
    const doc = parseMarkdown(
      'CLAUDE.md',
      '# Setup\n\n```bash\nnpm install\nnpm install -g corepack\n```\n',
    );
    const findings = await packageManagerConsistent.run(ctxOf([doc], repo));
    const plain = findings.find((f) => f.message.includes('`npm install`'))!;
    const global = findings.find((f) => f.message.includes('-g'))!;
    expect(plain.fix).toEqual({
      file: 'CLAUDE.md',
      line: 4,
      from: 'npm install',
      to: 'pnpm install',
    });
    expect(global.fix).toBeUndefined();
  });
});

describe('applyFixes end-to-end', () => {
  it('rewrites fixable findings on disk and the re-check comes back clean', async () => {
    const root = tempRepo();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'x', packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest' } }),
    );
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(join(root, 'scripts.py'), '');
    writeFileSync(
      join(root, 'CLAUDE.md'),
      [
        '# Rules',
        '',
        'Read [the guide](docs/Guide.md) and `Scripts.py` first.',
        '',
        '```bash',
        'npm install',
        'npm install -D vitest',
        '```',
        '',
      ].join('\n'),
    );

    const before = await runChecks(await loadProject(root), allChecks());
    expect(before.filter((f) => f.fix).length).toBeGreaterThanOrEqual(4);

    const { applied, files } = applyFixes(root, before);
    expect(files).toEqual(['CLAUDE.md']);
    expect(applied.length).toBe(before.filter((f) => f.fix).length);

    const text = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('[the guide](docs/guide.md)');
    expect(text).toContain('`scripts.py`');
    expect(text).toContain('pnpm install\npnpm add vitest -D');
    expect(text).not.toMatch(/^npm install/m);

    const after = await runChecks(await loadProject(root), allChecks());
    expect(after).toEqual([]);
  });

  it('skips a fix whose line no longer matches instead of guessing', () => {
    const root = tempRepo();
    writeFileSync(join(root, 'DOC.md'), 'something else entirely\n');
    const { applied, files } = applyFixes(root, [
      {
        check: 'path-exists',
        severity: 'error',
        confidence: 'high',
        message: 'stale',
        location: { file: 'DOC.md', line: 1 },
        fix: { file: 'DOC.md', line: 1, from: 'Old.md', to: 'old.md' },
      },
    ]);
    expect(applied).toEqual([]);
    expect(files).toEqual([]);
    expect(readFileSync(join(root, 'DOC.md'), 'utf8')).toBe('something else entirely\n');
  });
});
