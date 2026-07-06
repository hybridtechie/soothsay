import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * End-to-end tests of the compiled CLI — the actual user-facing surface.
 * Builds dist/ once (idempotent) and drives `node dist/cli.js` in temp repos.
 */

const pkgRoot = resolve(__dirname, '..');
const cliPath = join(pkgRoot, 'dist', 'cli.js');

interface RunResult {
  stdout: string;
  code: number;
}

function cli(args: string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync('node', [cliPath, ...args], { cwd, encoding: 'utf8' });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? -1 };
  }
}

let cleanRepo: string;
let driftedRepo: string;

beforeAll(() => {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: pkgRoot });

  cleanRepo = mkdtempSync(join(tmpdir(), 'soothsay-cli-clean-'));
  writeFileSync(join(cleanRepo, 'README.md'), '# Clean\n\nNothing to see.\n');

  driftedRepo = mkdtempSync(join(tmpdir(), 'soothsay-cli-drift-'));
  writeFileSync(
    join(driftedRepo, 'package.json'),
    JSON.stringify({ name: 'x', packageManager: 'pnpm@9.0.0', scripts: {} }),
  );
  writeFileSync(join(driftedRepo, 'pnpm-lock.yaml'), '');
  writeFileSync(
    join(driftedRepo, 'CLAUDE.md'),
    '# Rules\n\n```bash\nnpm install\n```\n\nSee [gone](docs/gone.md).\n',
  );
}, 120_000);

afterAll(() => {
  rmSync(cleanRepo, { recursive: true, force: true });
  rmSync(driftedRepo, { recursive: true, force: true });
});

describe('soothsay CLI', () => {
  it('check exits 0 on a clean repo', () => {
    const r = cli(['check', '.'], cleanRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no findings');
  });

  it('check exits 1 on a drifted repo and reports the findings', () => {
    const r = cli(['check', '.'], driftedRepo);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('package-manager');
    expect(r.stdout).toContain('FAIL');
  });

  it('check fails on a malformed soothsay.yml instead of silently using defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'soothsay-cli-badcfg-'));
    writeFileSync(join(root, 'README.md'), '# Clean\n\nNothing here.\n');
    writeFileSync(join(root, 'soothsay.yml'), ': : :\n  - [\n');
    const r = cli(['check', '.'], root);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('[config]');
    rmSync(root, { recursive: true, force: true });
  });

  it('bare path (no subcommand) defaults to check', () => {
    const r = cli(['.'], cleanRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('soothsay check');
  });

  it('check --json emits parseable JSON with the documented shape', () => {
    const r = cli(['check', '.', '--json'], driftedRepo);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.summary).toHaveProperty('errors');
    expect(parsed.findings[0]).toHaveProperty('check');
    expect(parsed.findings[0].location).toHaveProperty('file');
  });

  it('check --github emits workflow-command annotations', () => {
    const r = cli(['check', '.', '--github'], driftedRepo);
    expect(r.stdout).toMatch(/^::(error|warning|notice) file=/m);
  });

  it('init scaffolds soothsay.yml then refuses to overwrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'soothsay-cli-init-'));
    const first = cli(['init', '.'], root);
    expect(first.code).toBe(0);
    expect(existsSync(join(root, 'soothsay.yml'))).toBe(true);
    // Template recommends gitignoring the AI cache.
    expect(readFileSync(join(root, 'soothsay.yml'), 'utf8')).toContain('.soothsay-cache.json');
    const second = cli(['init', '.'], root);
    expect(second.code).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('init detects sources of truth and the scaffolded config passes check', () => {
    const root = mkdtempSync(join(tmpdir(), 'soothsay-cli-init-detect-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'x', packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest' } }),
    );
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    writeFileSync(
      join(root, 'CLAUDE.md'),
      '# Rules\n\n## Setup\n\n```bash\npnpm install\npnpm test\n```\n',
    );
    const r = cli(['init', '.'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('package-manager-pinned');
    const yml = readFileSync(join(root, 'soothsay.yml'), 'utf8');
    expect(yml).toContain('source: package.json#packageManager');
    expect(yml).toContain('expect: pnpm');
    // The generated config must not fail its own repo.
    const check = cli(['check', '.'], root);
    expect(check.code).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('check --fix rewrites safe findings and exits green', () => {
    const root = mkdtempSync(join(tmpdir(), 'soothsay-cli-fix-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'x', packageManager: 'pnpm@9.0.0', scripts: {} }),
    );
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    writeFileSync(join(root, 'guide.md'), '# Guide\n');
    writeFileSync(
      join(root, 'CLAUDE.md'),
      '# Rules\n\nSee [the guide](Guide.md).\n\n```bash\nnpm install\n```\n',
    );

    // Without --fix: fails, and points at the autofix.
    const before = cli(['check', '.'], root);
    expect(before.code).toBe(1);
    expect(before.stdout).toContain('auto-fixable');

    const fixed = cli(['check', '.', '--fix'], root);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain('applied 2 autofix(es)');
    const text = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('[the guide](guide.md)');
    expect(text).toContain('pnpm install');
    rmSync(root, { recursive: true, force: true });
  });

  it('explain prints a known check and lists checks for unknown ids', () => {
    const known = cli(['explain', 'tool-claim-mismatch'], cleanRepo);
    expect(known.code).toBe(0);
    expect(known.stdout).toContain('read-only');
    const unknown = cli(['explain', 'not-a-check'], cleanRepo);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain('path-exists');
  });

  it('bless exits 0 and updates directives; exits 0 (not 1) when none exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'soothsay-cli-bless-'));
    writeFileSync(
      join(root, 'DOC.md'),
      '# T\n<!-- fresh: verified=2020-01-01 watch=package.json -->\n',
    );
    const blessed = cli(['bless', 'DOC.md', '--date', '2026-07-04'], root);
    expect(blessed.code).toBe(0);
    expect(readFileSync(join(root, 'DOC.md'), 'utf8')).toContain('verified=2026-07-04');

    writeFileSync(join(root, 'PLAIN.md'), '# no directives\n');
    const noop = cli(['bless', 'PLAIN.md'], root);
    expect(noop.code).toBe(0);
    expect(noop.stdout).toContain('No fresh directives');
    rmSync(root, { recursive: true, force: true });
  });

  it('--help prints usage and exits 0', () => {
    const r = cli(['--help'], cleanRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('soothsay check');
    expect(r.stdout).toContain('bless');
  });
});
