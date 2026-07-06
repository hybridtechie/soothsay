import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject, runChecks, verdict } from '../src/engine.js';
import { allChecks } from '../src/checks/index.js';

let root: string;

function git(args: string[], env: Record<string, string> = {}) {
  execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
    stdio: 'ignore',
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'soothsay-e2e-'));
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', packageManager: 'pnpm@9.1.0', scripts: { test: 'vitest' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

  writeFileSync(
    join(root, 'CLAUDE.md'),
    [
      '# Rules',
      '',
      '## Setup',
      '',
      '<!-- fresh: verified=2026-01-01 watch=package.json -->',
      '',
      'Run `npm install` to set up.', // wrong package manager
      'Run `pnpm test` before committing.', // valid script
      'Deploy with `bash scripts/deploy.sh`.', // missing file
      '',
      'See [architecture](docs/missing.md).', // broken link
    ].join('\n'),
  );

  writeFileSync(
    join(root, '.claude', 'agents', 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      'description: Reviews code. This agent is read-only and never writes files.',
      'tools: Read, Grep, Edit',
      '---',
      '',
      '# Reviewer',
    ].join('\n'),
  );

  writeFileSync(
    join(root, 'soothsay.yml'),
    [
      'asserts:',
      '  - id: pm-truth',
      '    doc: CLAUDE.md#setup',
      '    forbid_command: ["npm install"]',
      '    source: package.json#packageManager',
      '    expect: pnpm',
      '  - id: ghost-anchor',
      '    doc: CLAUDE.md#no-such-heading',
      '    require_file: ["package.json"]',
    ].join('\n'),
  );

  // git history: a commit touching package.json AFTER the verified date
  git(['init', '-q']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init'], {
    GIT_AUTHOR_DATE: '2026-06-20T10:00:00',
    GIT_COMMITTER_DATE: '2026-06-20T10:00:00',
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('soothsay end-to-end on a drifted repo', () => {
  it('catches every planted drift', async () => {
    const ctx = await loadProject(root);
    const findings = await runChecks(ctx, allChecks());
    const byCheck = (name: string) => findings.filter((f) => f.check === name);

    // package-manager: npm install in a pnpm repo
    expect(byCheck('package-manager').length).toBeGreaterThanOrEqual(1);
    // command-exists: scripts/deploy.sh missing
    expect(
      byCheck('command-exists').some((f) => f.message.includes('scripts/deploy.sh')),
    ).toBe(true);
    // link-valid: docs/missing.md
    expect(byCheck('link-valid').some((f) => f.message.includes('docs/missing.md'))).toBe(true);
    // tool-claim-mismatch: read-only agent with Edit tool
    expect(byCheck('tool-claim-mismatch').length).toBeGreaterThanOrEqual(1);
    // freshness: package.json committed after verified=2026-01-01
    expect(byCheck('freshness').some((f) => f.severity === 'warning')).toBe(true);
    // asserts: forbidden npm install caught by the sidecar rule too
    expect(byCheck('asserts').length).toBeGreaterThanOrEqual(1);
    // assert-anchor: ghost-anchor points at a heading that does not exist
    expect(byCheck('assert-anchor').length).toBeGreaterThanOrEqual(1);

    // pnpm test is valid — must NOT be flagged
    expect(findings.some((f) => f.message.includes('pnpm test'))).toBe(false);

    const v = verdict(findings);
    expect(v.failed).toBe(true);
    expect(v.errors).toBeGreaterThanOrEqual(3);
  });

  it('a clean minimal repo passes', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'soothsay-clean-'));
    writeFileSync(join(clean, 'README.md'), '# Hello\n\nJust a readme.\n');
    const ctx = await loadProject(clean);
    const findings = await runChecks(ctx, allChecks());
    const v = verdict(findings);
    expect(v.failed).toBe(false);
    rmSync(clean, { recursive: true, force: true });
  });
});
