import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { buildInitConfig } from '../src/init.js';
import { loadProject, runChecks } from '../src/engine.js';
import { allChecks } from '../src/checks/index.js';

const roots: string[] = [];
function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'soothsay-init-'));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A repo with every source of truth init knows how to detect. */
function richRepo(): string {
  const root = tempRepo();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'x',
      packageManager: 'pnpm@9.0.0',
      scripts: { test: 'vitest run', build: 'tsc' },
    }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeFileSync(
    join(root, 'CLAUDE.md'),
    ['# Rules', '', '## Setup', '', '```bash', 'pnpm install', 'pnpm test', '```', ''].join('\n'),
  );
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'agents', 'helper.md'),
    ['---', 'name: helper', 'description: reads things', 'tools: Read, Grep', '---', '', '# Helper', ''].join('\n'),
  );
  return root;
}

describe('soothsay init auto-detection', () => {
  it('detects package manager, agent tools, and documented scripts', async () => {
    const { proposals, yamlText, summary } = await buildInitConfig(richRepo());
    const ids = proposals.map((p) => p.rule.id);
    expect(ids).toContain('package-manager-pinned');
    expect(ids).toContain('no-foreign-package-managers');
    expect(ids).toContain('pin-tools-helper');
    expect(ids).toContain('docs-instruct-test');
    expect(ids).not.toContain('docs-instruct-build'); // build exists but is undocumented

    const pinned = proposals.find((p) => p.rule.id === 'package-manager-pinned')!.rule;
    expect(pinned.source).toBe('package.json#packageManager');
    expect(pinned.expect).toBe('pnpm');
    // Anchored into the CLAUDE.md Setup heading.
    expect(pinned.doc).toBe('CLAUDE.md#setup');

    const tools = proposals.find((p) => p.rule.id === 'pin-tools-helper')!.rule;
    expect(tools.agent).toBe('.claude/agents/helper.md');
    expect(tools.allowed).toEqual(['Read', 'Grep']);

    const required = proposals.find((p) => p.rule.id === 'docs-instruct-test')!.rule;
    expect(required.require_command).toEqual(['pnpm test']);

    // The YAML parses and carries exactly the proposed asserts.
    const parsed = YAML.parse(yamlText);
    expect(parsed.asserts.map((a: { id: string }) => a.id)).toEqual(ids);
    expect(summary.some((l) => l.includes('4 assert(s)'))).toBe(true);
  });

  it("never forbids a command the docs currently use — the scaffold must pass on day one", async () => {
    const root = richRepo();
    // Docs (wrongly) instruct npm install; the built-in check flags that,
    // but init must not scaffold an assert that fails immediately.
    writeFileSync(
      join(root, 'AGENTS.md'),
      ['# Agents', '', '```bash', 'npm install', '```', ''].join('\n'),
    );
    const { proposals, yamlText } = await buildInitConfig(root);
    const forbid = proposals.find((p) => p.rule.id === 'no-foreign-package-managers')!.rule;
    expect(forbid.forbid_command).not.toContain('npm install');
    expect(forbid.forbid_command).toContain('yarn install');

    // Write the scaffold and prove the assert layer passes against the repo.
    writeFileSync(join(root, 'soothsay.yml'), yamlText);
    const findings = await runChecks(await loadProject(root), allChecks());
    const assertFindings = findings.filter((f) =>
      ['asserts', 'assert-anchor', 'assert-conflicts', 'config'].includes(f.check),
    );
    expect(assertFindings).toEqual([]);
  });

  it('falls back to the commented example when nothing is detectable', async () => {
    const root = tempRepo();
    writeFileSync(join(root, 'README.md'), '# Bare\n\nNothing here.\n');
    const { proposals, yamlText, summary } = await buildInitConfig(root);
    expect(proposals).toEqual([]);
    expect(yamlText).toContain('asserts: []');
    expect(YAML.parse(yamlText).asserts).toEqual([]);
    expect(summary.some((l) => l.includes('No sources of truth'))).toBe(true);
  });

  it('pins the package manager from a lockfile alone (no packageManager field)', async () => {
    const root = tempRepo();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
    writeFileSync(join(root, 'yarn.lock'), '');
    writeFileSync(join(root, 'CLAUDE.md'), '# Rules\n\nUse `yarn install`.\n');
    const { proposals } = await buildInitConfig(root);
    const ids = proposals.map((p) => p.rule.id);
    // No packageManager field → no value_matches_source assert...
    expect(ids).not.toContain('package-manager-pinned');
    // ...but foreign managers are still forbidden, minus none in use.
    const forbid = proposals.find((p) => p.rule.id === 'no-foreign-package-managers')!.rule;
    expect(forbid.forbid_command).toContain('npm install');
    expect(forbid.forbid_command).not.toContain('yarn install');
    expect(forbid.source).toBeUndefined();
  });
});
