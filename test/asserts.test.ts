import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../src/parser/markdown.js';
import { assertsCheck } from '../src/asserts/run.js';
import { assertConflicts } from '../src/asserts/conflicts.js';
import type {
  AssertRule,
  CheckContext,
  DocFile,
  Finding,
  RepoFacts,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRepo(root: string, files: string[] = []): RepoFacts {
  return {
    root,
    files: new Set(files),
    dirs: new Set(),
    filesLower: new Map(files.map((f) => [f.toLowerCase(), f])),
    packageJson: null,
    packageScripts: new Set(),
    lockfiles: [],
    packageManager: null,
    packageManagerSource: null,
  };
}

function makeCtx(opts: {
  asserts: AssertRule[];
  docs?: DocFile[];
  repo?: RepoFacts;
}): CheckContext {
  return {
    repo: opts.repo ?? makeRepo('/nonexistent'),
    docs: opts.docs ?? [],
    config: { docs: [], ignore: [], disable: [], asserts: opts.asserts },
  };
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  return await assertsCheck.run(ctx);
}

async function runConflicts(ctx: CheckContext): Promise<Finding[]> {
  return await assertConflicts.run(ctx);
}

/**
 * CLAUDE.md fixture. The fenced block opens on line 7, so its code lines are:
 *   line 8: "pnpm install"
 *   line 9: "cd app && npm install"
 */
const claudeMd = parseMarkdown(
  'CLAUDE.md',
  [
    '# Rules',
    '',
    '## Install',
    '',
    'Run `pnpm install` then check.',
    '',
    '```bash',
    'pnpm install',
    'cd app && npm install',
    '```',
  ].join('\n'),
);

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'soothsay-asserts-'));
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'api', 'handler.ts'),
    ['// entry point', "import axios from 'axios';", 'export const x = 1;'].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'api', 'legacy.ts'),
    ["const axios = require('axios');", 'module.exports = axios;'].join('\n'),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', packageManager: 'pnpm@9.1.0' }),
  );
  writeFileSync(join(root, 'conf.yml'), 'build:\n  version: 2.0.0\npi: 9.1\ncount: 20\nflag: true\n');
  writeFileSync(
    join(root, '.claude', 'agents', 'helper.md'),
    ['---', 'tools: Read, Grep, Bash', '---', '# Helper'].join('\n'),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

describe('assertsCheck: anchors', () => {
  it('flags an anchor to a file that is not scanned', async () => {
    const ctx = makeCtx({
      docs: [claudeMd],
      asserts: [{ id: 'a1', doc: 'MISSING.md#install', require_command: ['pnpm install'] }],
    });
    const findings = await run(ctx);
    const anchor = findings.filter((f) => f.check === 'assert-anchor');
    expect(anchor).toHaveLength(1);
    expect(anchor[0]?.severity).toBe('error');
    expect(anchor[0]?.confidence).toBe('high');
    expect(anchor[0]?.message).toContain('assert "a1" is anchored to MISSING.md#install');
    expect(anchor[0]?.message).toContain('the file is not scanned');
  });

  it('flags an anchor to a missing heading and suggests near-miss slugs', async () => {
    const ctx = makeCtx({
      docs: [claudeMd],
      asserts: [{ id: 'a2', doc: 'CLAUDE.md#instal', require_command: ['pnpm install'] }],
    });
    const findings = await run(ctx);
    const anchor = findings.filter((f) => f.check === 'assert-anchor');
    expect(anchor).toHaveLength(1);
    expect(anchor[0]?.message).toContain('the heading does not exist');
    expect(anchor[0]?.suggestion).toContain('install');
  });

  it('is silent for a valid anchor (with and without slug)', async () => {
    const ctx = makeCtx({
      docs: [claudeMd],
      asserts: [
        { id: 'a3', doc: 'CLAUDE.md#install', require_command: ['pnpm install'] },
        { id: 'a4', doc: 'CLAUDE.md', require_command: ['pnpm install'] },
      ],
    });
    expect(await run(ctx)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// forbid_command
// ---------------------------------------------------------------------------

describe('assertsCheck: forbid_command', () => {
  it('flags a hit inside a fenced block with the real line number', async () => {
    const ctx = makeCtx({
      docs: [claudeMd],
      asserts: [
        { id: 'pm', forbid_command: ['npm install'], source: 'package.json#packageManager' },
      ],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('asserts');
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.location).toEqual({ file: 'CLAUDE.md', line: 9 });
    expect(findings[0]?.message).toBe(
      '`npm install` is forbidden by assert "pm" but appears in CLAUDE.md',
    );
    expect(findings[0]?.suggestion).toBe('Source of truth: package.json#packageManager');
  });

  it('flags a hit in inline code', async () => {
    const doc = parseMarkdown('README.md', 'First `npm install`, then build.');
    const ctx = makeCtx({
      docs: [doc],
      asserts: [{ id: 'pm', forbid_command: ['npm install'] }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toEqual({ file: 'README.md', line: 1 });
    expect(findings[0]?.suggestion).toBeUndefined();
  });

  it('respects the scope glob — docs outside scope are not flagged', async () => {
    const inScope = parseMarkdown('docs/setup.md', 'Use `npm install` here.');
    const outOfScope = parseMarkdown('README.md', 'Use `npm install` here.');
    const ctx = makeCtx({
      docs: [inScope, outOfScope],
      asserts: [{ id: 'pm', forbid_command: ['npm install'], scope: 'docs/**' }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.file).toBe('docs/setup.md');
  });

  it('only matches at command position — mid-segment mentions are ignored', async () => {
    const doc = parseMarkdown('README.md', 'See `run npm install now` for details.');
    const ctx = makeCtx({
      docs: [doc],
      asserts: [{ id: 'pm', forbid_command: ['npm install'] }],
    });
    expect(await run(ctx)).toHaveLength(0);
  });

  it('downgrades a negative-example mention to info/low', async () => {
    const doc = parseMarkdown('README.md', 'Never run `npm install` here — use pnpm.');
    const ctx = makeCtx({
      docs: [doc],
      asserts: [{ id: 'pm', forbid_command: ['npm install'] }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.confidence).toBe('low');
    expect(findings[0]?.message).toContain('(appears in a negative example)');
  });

  it('downgrades a fenced hit preceded by a negation comment, keeps plain hits blocking', async () => {
    const doc = parseMarkdown(
      'README.md',
      ['```bash', '# avoid this:', 'npm install', '```', '', '```bash', 'npm install', '```'].join('\n'),
    );
    const ctx = makeCtx({
      docs: [doc],
      asserts: [{ id: 'pm', forbid_command: ['npm install'] }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(2);
    const downgraded = findings.find((f) => f.location.line === 3);
    const blocking = findings.find((f) => f.location.line === 7);
    expect(downgraded?.severity).toBe('info');
    expect(blocking?.severity).toBe('error');
    expect(blocking?.confidence).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// require_command
// ---------------------------------------------------------------------------

describe('assertsCheck: require_command', () => {
  it('is silent when the command appears in a scanned doc', async () => {
    const ctx = makeCtx({
      docs: [claudeMd],
      asserts: [{ id: 'req', require_command: ['pnpm install'] }],
    });
    expect(await run(ctx)).toHaveLength(0);
  });

  it('flags a required command missing from every doc in scope', async () => {
    const ctx = makeCtx({
      docs: [claudeMd],
      asserts: [{ id: 'req', require_command: ['pnpm test'] }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toEqual({ file: 'soothsay.yml', line: 1 });
    expect(findings[0]?.message).toContain(
      '`pnpm test` is required by assert "req" but not found in any scanned doc',
    );
  });
});

// ---------------------------------------------------------------------------
// require_file
// ---------------------------------------------------------------------------

describe('assertsCheck: require_file', () => {
  const repo = makeRepo('/nonexistent', ['src/App.tsx', 'scripts/sync.py']);

  it('is silent when the file exists exactly', async () => {
    const ctx = makeCtx({ repo, asserts: [{ id: 'f', require_file: ['src/App.tsx'] }] });
    expect(await run(ctx)).toHaveLength(0);
  });

  it('flags a case-only mismatch with a suggestion', async () => {
    const ctx = makeCtx({ repo, asserts: [{ id: 'f', require_file: ['src/app.tsx'] }] });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.suggestion).toContain('src/App.tsx');
  });

  it('flags a missing file', async () => {
    const ctx = makeCtx({ repo, asserts: [{ id: 'f', require_file: ['src/gone.ts'] }] });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('src/gone.ts');
    expect(findings[0]?.message).toContain('assert "f"');
    expect(findings[0]?.suggestion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// forbid_import
// ---------------------------------------------------------------------------

describe('assertsCheck: forbid_import', () => {
  it('flags a forbidden import with the real file and line', async () => {
    const repo = makeRepo(root, ['src/api/handler.ts']);
    const ctx = makeCtx({
      repo,
      asserts: [{ id: 'no-axios', forbid_import: 'axios', in: 'src/api/**' }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toEqual({ file: 'src/api/handler.ts', line: 2 });
    expect(findings[0]?.message).toBe(
      '"axios" is imported in src/api/handler.ts but forbidden by assert "no-axios"',
    );
  });

  it('honors except globs (and catches require() elsewhere)', async () => {
    const repo = makeRepo(root, ['src/api/handler.ts', 'src/api/legacy.ts']);
    const withExcept = makeCtx({
      repo,
      asserts: [
        {
          id: 'no-axios',
          forbid_import: 'axios',
          in: 'src/api/**',
          except: ['src/api/legacy.ts'],
        },
      ],
    });
    const findings = await run(withExcept);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.file).toBe('src/api/handler.ts');

    const withoutExcept = makeCtx({
      repo,
      asserts: [{ id: 'no-axios', forbid_import: 'axios', in: 'src/api/**' }],
    });
    const all = await run(withoutExcept);
    expect(all).toHaveLength(2);
    expect(all.map((f) => f.location.file).sort()).toEqual([
      'src/api/handler.ts',
      'src/api/legacy.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// value_matches_source
// ---------------------------------------------------------------------------

describe('assertsCheck: value_matches_source', () => {
  it('matches a versioned value when expect has no @ suffix', async () => {
    const ctx = makeCtx({
      repo: makeRepo(root),
      asserts: [{ id: 'pm', source: 'package.json#packageManager', expect: 'pnpm' }],
    });
    expect(await run(ctx)).toHaveLength(0);
  });

  it('flags a mismatch, resolving nested dot paths in yaml', async () => {
    const ctx = makeCtx({
      repo: makeRepo(root),
      asserts: [{ id: 'ver', source: 'conf.yml#build.version', expect: '1.0.0' }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      'conf.yml#build.version is "2.0.0" but assert "ver" expects "1.0.0"',
    );
  });

  it('coerces numeric and boolean expect values instead of crashing', async () => {
    const ctx = makeCtx({
      repo: makeRepo(root),
      asserts: [
        { id: 'pi', source: 'conf.yml#pi', expect: 9.1 },
        { id: 'count', source: 'conf.yml#count', expect: 20 },
        { id: 'flag', source: 'conf.yml#flag', expect: true },
      ],
    });
    expect(await run(ctx)).toHaveLength(0);
  });

  it('flags a numeric mismatch after coercion', async () => {
    const ctx = makeCtx({
      repo: makeRepo(root),
      asserts: [{ id: 'pi', source: 'conf.yml#pi', expect: 3.2 }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('expects "3.2"');
  });

  it('flags a missing source of truth', async () => {
    const ctx = makeCtx({
      repo: makeRepo(root),
      asserts: [{ id: 'gone', source: 'nope.json#some.path', expect: 'x' }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('source of truth nope.json#some.path not found');
  });
});

// ---------------------------------------------------------------------------
// tools_subset
// ---------------------------------------------------------------------------

describe('assertsCheck: tools_subset', () => {
  it('is silent when frontmatter tools are all allowed', async () => {
    const ctx = makeCtx({
      repo: makeRepo(root),
      asserts: [
        { id: 't', agent: '.claude/agents/helper.md', allowed: ['Read', 'Grep', 'Bash'] },
      ],
    });
    expect(await run(ctx)).toHaveLength(0);
  });

  it('flags each tool outside the allowed set', async () => {
    const ctx = makeCtx({
      repo: makeRepo(root),
      asserts: [{ id: 't', agent: '.claude/agents/helper.md', allowed: ['Read', 'Grep'] }],
    });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      'agent .claude/agents/helper.md has tool Bash but assert "t" allows only [Read, Grep]',
    );
  });
});

// ---------------------------------------------------------------------------
// unknown rule shape
// ---------------------------------------------------------------------------

describe('assertsCheck: unknown rule shape', () => {
  it('warns on a rule with no recognized assertion keys', async () => {
    const ctx = makeCtx({ asserts: [{ id: 'weird' }] });
    const findings = await run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.message).toBe('assert "weird" has no recognized assertion keys');
  });
});

// ---------------------------------------------------------------------------
// assertConflicts
// ---------------------------------------------------------------------------

describe('assertConflicts', () => {
  it('flags duplicate ids', async () => {
    const ctx = makeCtx({
      asserts: [
        { id: 'dup', require_file: ['a.ts'] },
        { id: 'dup', require_file: ['b.ts'] },
      ],
    });
    const findings = await runConflicts(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.message).toContain('duplicate');
    expect(findings[0]?.message).toContain('"dup"');
  });

  it('flags forbid vs require of the same command with overlapping scopes', async () => {
    const ctx = makeCtx({
      docs: [claudeMd],
      asserts: [
        { id: 'no-npm', forbid_command: ['npm install'] },
        { id: 'want-npm', require_command: ['npm install'] },
      ],
    });
    const findings = await runConflicts(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"no-npm"');
    expect(findings[0]?.message).toContain('"want-npm"');
    expect(findings[0]?.message).toContain('npm install');
    expect(findings[0]?.suggestion).toContain('narrow');
  });

  it('does not flag forbid vs require when scopes are disjoint', async () => {
    const ctx = makeCtx({
      docs: [
        parseMarkdown('docs/a.md', 'x'),
        parseMarkdown('guides/b.md', 'y'),
      ],
      asserts: [
        { id: 'no-npm', forbid_command: ['npm install'], scope: 'docs/**' },
        { id: 'want-npm', require_command: ['npm install'], scope: 'guides/**' },
      ],
    });
    expect(await runConflicts(ctx)).toHaveLength(0);
  });

  it('flags two value asserts competing over the same source', async () => {
    const ctx = makeCtx({
      asserts: [
        { id: 'p1', source: 'package.json#packageManager', expect: 'pnpm' },
        { id: 'p2', source: 'package.json#packageManager', expect: 'yarn' },
      ],
    });
    const findings = await runConflicts(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      'asserts "p1" and "p2" both claim package.json#packageManager but expect "pnpm" vs "yarn"',
    );
  });
});
