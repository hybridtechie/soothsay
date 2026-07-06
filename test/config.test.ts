import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { DEFAULT_DOC_GLOBS } from '../src/types.js';
import { runChecks, verdict } from '../src/engine.js';
import type { Check, CheckContext, Finding } from '../src/types.js';

const roots: string[] = [];
const makeRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'soothsay-cfg-'));
  roots.push(r);
  return r;
};
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('zero-config defaults include every default doc glob (cursor rules too)', () => {
    const cfg = loadConfig(makeRoot());
    expect(cfg.docs).toEqual(DEFAULT_DOC_GLOBS);
    expect(cfg.docs).toContain('.cursor/rules/**/*.md*');
    expect(cfg.disable).toEqual([]);
    expect(cfg.asserts).toEqual([]);
  });

  it('malformed yaml falls back to defaults without throwing', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'soothsay.yml'), ': : :\n  - [\n');
    const cfg = loadConfig(root);
    expect(cfg.docs).toEqual(DEFAULT_DOC_GLOBS);
  });

  it('non-object yaml (a bare list) falls back to defaults', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'soothsay.yml'), '- just\n- a list\n');
    const cfg = loadConfig(root);
    expect(cfg.docs).toEqual(DEFAULT_DOC_GLOBS);
  });

  it('surfaces a configError for malformed or non-mapping config, none when missing', () => {
    const missing = loadConfig(makeRoot());
    expect(missing.configError).toBeUndefined();

    const badRoot = makeRoot();
    writeFileSync(join(badRoot, 'soothsay.yml'), ': : :\n  - [\n');
    expect(loadConfig(badRoot).configError).toMatch(/soothsay\.yml/);

    const listRoot = makeRoot();
    writeFileSync(join(listRoot, 'soothsay.yml'), '- just\n- a list\n');
    expect(loadConfig(listRoot).configError).toMatch(/mapping/i);
  });

  it('resolves the soothsay.yaml and .soothsay.yml filename fallbacks', () => {
    for (const name of ['soothsay.yaml', '.soothsay.yml']) {
      const root = makeRoot();
      writeFileSync(join(root, name), 'disable: ["link-valid"]\n');
      expect(loadConfig(root).disable).toEqual(['link-valid']);
    }
  });

  it('ignore entries are appended to the built-in ignores', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'soothsay.yml'), 'ignore: ["vendored/**"]\n');
    const cfg = loadConfig(root);
    expect(cfg.ignore).toContain('vendored/**');
    expect(cfg.ignore).toContain('**/node_modules/**');
  });
});

function emptyCtx(overrides: Partial<CheckContext['config']> = {}): CheckContext {
  return {
    repo: {
      root: '/fake',
      files: new Set<string>(),
      dirs: new Set<string>(),
      filesLower: new Map<string, string>(),
      packageJson: null,
      packageScripts: new Set<string>(),
      lockfiles: [],
      packageManager: null,
      packageManagerSource: null,
    },
    docs: [],
    config: { docs: [], ignore: [], disable: [], asserts: [], ...overrides },
  };
}

describe('runChecks + configError', () => {
  it('a malformed config surfaces as a blocking config finding', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'soothsay.yml'), ': : :\n  - [\n');
    const config = loadConfig(root);
    const ctx = emptyCtx({ configError: config.configError });
    const findings = await runChecks(ctx, []);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('config');
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.location).toEqual({ file: 'soothsay.yml', line: 1 });
    expect(verdict(findings).failed).toBe(true);
  });

  it('no config finding when the config is absent or valid', async () => {
    const findings = await runChecks(emptyCtx(), []);
    expect(findings).toEqual([]);
  });
});

describe('verdict + ai-advisory', () => {
  const ai = (severity: Finding['severity']): Finding => ({
    check: 'ai-advisory',
    severity,
    confidence: 'low',
    message: 'advisory',
    location: { file: 'CLAUDE.md', line: 1 },
  });

  it('ai-advisory findings never block, even under --strict', () => {
    const v = verdict([ai('warning'), ai('info')], true);
    expect(v.failed).toBe(false);
    expect(v.warnings).toBe(1);
    expect(v.infos).toBe(1);
  });

  it('real warnings still block under --strict', () => {
    const real: Finding = {
      check: 'path-exists',
      severity: 'warning',
      confidence: 'medium',
      message: 'x',
      location: { file: 'CLAUDE.md', line: 1 },
    };
    expect(verdict([real, ai('warning')], true).failed).toBe(true);
  });
});

describe('runChecks + disable', () => {
  it('a disabled check never runs', async () => {
    let ran = 0;
    const probe: Check = {
      name: 'probe',
      run() {
        ran++;
        return [];
      },
    };
    const ctx = {
      repo: {
        root: '/fake',
        files: new Set<string>(),
        dirs: new Set<string>(),
        filesLower: new Map<string, string>(),
        packageJson: null,
        packageScripts: new Set<string>(),
        lockfiles: [],
        packageManager: null,
        packageManagerSource: null,
      },
      docs: [],
      config: { docs: [], ignore: [], disable: ['probe'], asserts: [] },
    };
    await runChecks(ctx, [probe]);
    expect(ran).toBe(0);
    ctx.config.disable = [];
    await runChecks(ctx, [probe]);
    expect(ran).toBe(1);
  });
});
