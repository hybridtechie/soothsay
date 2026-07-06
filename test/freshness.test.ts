import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../src/parser/markdown.js';
import { parseFreshDirectives } from '../src/freshness/directive.js';
import { makeFreshnessCheck, type GitRunner } from '../src/freshness/check.js';
import { bless } from '../src/freshness/bless.js';
import type { CheckContext, DocFile } from '../src/types.js';

function makeCtx(root: string, docs: DocFile[]): CheckContext {
  return {
    repo: {
      root,
      files: new Set(),
      dirs: new Set(),
      filesLower: new Map(),
      packageJson: null,
      packageScripts: new Set(),
      lockfiles: [],
      packageManager: null,
      packageManagerSource: null,
    },
    docs,
    config: { docs: [], ignore: [], disable: [], asserts: [] },
  };
}

describe('parseFreshDirectives', () => {
  it('parses a full directive and attributes it to the nearest heading above', () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      [
        '# Getting Started',
        '',
        '## Auth Setup',
        '',
        'Some prose.',
        '',
        '<!-- fresh: verified=2026-07-01 watch=package.json,src/auth/** owner=platform -->',
        '',
        '## Later Section',
        '',
      ].join('\n'),
    );
    const { directives, errors } = parseFreshDirectives(doc);
    expect(errors).toEqual([]);
    expect(directives).toHaveLength(1);
    const d = directives[0]!;
    expect(d.file).toBe('CLAUDE.md');
    expect(d.line).toBe(7);
    expect(d.verified).toBe('2026-07-01');
    expect(d.watch).toEqual(['package.json', 'src/auth/**']);
    expect(d.owner).toBe('platform');
    expect(d.section).toBe('Auth Setup');
    expect(d.sectionSlug).toBe('auth-setup');
  });

  it('gives a directive above any heading a null section', () => {
    const doc = parseMarkdown(
      'x.md',
      '<!-- fresh: verified=2026-07-01 watch=a.txt -->\n\n# First Heading\n',
    );
    const { directives, errors } = parseFreshDirectives(doc);
    expect(errors).toEqual([]);
    expect(directives).toHaveLength(1);
    expect(directives[0]!.section).toBeNull();
    expect(directives[0]!.sectionSlug).toBeNull();
  });

  it('ignores comments that are not fresh directives', () => {
    const doc = parseMarkdown('x.md', '<!-- just a note -->\n<!-- freshness is nice -->\n');
    const { directives, errors } = parseFreshDirectives(doc);
    expect(directives).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('drops a directive with an invalid verified date and reports an error', () => {
    const doc = parseMarkdown('x.md', '# H\n\n<!-- fresh: verified=2026-13-99 watch=a.txt -->\n');
    const { directives, errors } = parseFreshDirectives(doc);
    expect(directives).toEqual([]);
    expect(errors).toHaveLength(1);
    const e = errors[0]!;
    expect(e.check).toBe('freshness');
    expect(e.severity).toBe('error');
    expect(e.confidence).toBe('high');
    expect(e.location).toEqual({ file: 'x.md', line: 3 });
    expect(e.message).toMatch(/verified/i);
  });

  it('drops a directive with a missing verified date and reports an error', () => {
    const doc = parseMarkdown('x.md', '<!-- fresh: watch=a.txt owner=core -->\n');
    const { directives, errors } = parseFreshDirectives(doc);
    expect(directives).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe('error');
  });

  it('drops a directive with an empty watch list and reports an error', () => {
    const doc = parseMarkdown('x.md', '<!-- fresh: verified=2026-07-01 watch= -->\n');
    const { directives, errors } = parseFreshDirectives(doc);
    expect(directives).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/watch/i);
  });

  it('accepts an optional time suffix on verified', () => {
    for (const v of ['2026-07-04T14:30', '2026-07-04T14:30:15']) {
      const doc = parseMarkdown('x.md', `<!-- fresh: verified=${v} watch=a.txt -->\n`);
      const { directives, errors } = parseFreshDirectives(doc);
      expect(errors).toEqual([]);
      expect(directives).toHaveLength(1);
      expect(directives[0]!.verified).toBe(v);
    }
  });

  it('rejects malformed time suffixes', () => {
    for (const v of ['2026-07-04T99:99', '2026-07-04T14']) {
      const doc = parseMarkdown('x.md', `<!-- fresh: verified=${v} watch=a.txt -->\n`);
      const { directives, errors } = parseFreshDirectives(doc);
      expect(directives).toEqual([]);
      expect(errors).toHaveLength(1);
    }
  });
});

describe('freshness check (fake git)', () => {
  const STALE_DOC = parseMarkdown(
    'CLAUDE.md',
    '# Auth\n\n<!-- fresh: verified=2026-06-01 watch=src/auth/**,package.json -->\n',
  );

  it('warns when watched paths have commits after the verified date', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const git: GitRunner = (args, cwd) => {
      calls.push({ args, cwd });
      return 'abc123 tighten token checks\ndef456 rotate keys';
    };
    const findings = await makeFreshnessCheck(git).run(makeCtx('/repo', [STALE_DOC]));
    expect(calls).toEqual([
      {
        args: [
          'log',
          '--since=2026-06-01T23:59:59',
          '--pretty=format:%h %s',
          '--',
          'src/auth/**',
          'package.json',
        ],
        cwd: '/repo',
      },
    ]);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('freshness');
    expect(f.severity).toBe('warning');
    expect(f.confidence).toBe('high');
    expect(f.location).toEqual({ file: 'CLAUDE.md', line: 3 });
    expect(f.message).toBe(
      '"Auth" was last verified 2026-06-01, but 2 commit(s) touched watched paths since ' +
        '(latest: abc123 tighten token checks)',
    );
    expect(f.suggestion).toBe('Re-verify the section, then run: soothsay bless CLAUDE.md');
  });

  it('emits nothing when git reports no commits since the verified date', async () => {
    const findings = await makeFreshnessCheck(() => '').run(makeCtx('/repo', [STALE_DOC]));
    expect(findings).toEqual([]);
  });

  it('emits a single info finding and stops when git is unavailable', async () => {
    const doc = parseMarkdown(
      'x.md',
      '# A\n\n<!-- fresh: verified=2026-06-01 watch=a.txt -->\n\n' +
        '# B\n\n<!-- fresh: verified=2026-06-01 watch=b.txt -->\n',
    );
    let calls = 0;
    const git: GitRunner = () => {
      calls++;
      throw new Error('not a git repository');
    };
    const findings = await makeFreshnessCheck(git).run(makeCtx('/nowhere', [doc]));
    expect(calls).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.confidence).toBe('low');
    expect(findings[0]!.message).toMatch(/git/i);
    expect(findings[0]!.message).toMatch(/skip/i);
  });

  it('surfaces directive parse errors through run without calling git', async () => {
    const doc = parseMarkdown('x.md', '<!-- fresh: verified=nope watch=a.txt -->\n');
    let calls = 0;
    const git: GitRunner = () => {
      calls++;
      return '';
    };
    const findings = await makeFreshnessCheck(git).run(makeCtx('/repo', [doc]));
    expect(calls).toBe(0);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
  });

  it('uses the exact verified value as --since when a time is present', async () => {
    const doc = parseMarkdown(
      'x.md',
      '# A\n\n<!-- fresh: verified=2026-07-04T14:30 watch=a.txt -->\n',
    );
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      return '';
    };
    await makeFreshnessCheck(git).run(makeCtx('/repo', [doc]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--since=2026-07-04T14:30');
  });

  it('collects parse errors from every doc even when git is unavailable', async () => {
    const good = parseMarkdown('a.md', '# A\n\n<!-- fresh: verified=2026-06-01 watch=a.txt -->\n');
    const broken = parseMarkdown('b.md', '<!-- fresh: verified=nope watch=b.txt -->\n');
    const git: GitRunner = () => {
      throw new Error('not a git repository');
    };
    const findings = await makeFreshnessCheck(git).run(makeCtx('/nowhere', [good, broken]));
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.severity === 'error' && f.location.file === 'b.md')).toBe(true);
    expect(findings.some((f) => f.severity === 'info' && /git/i.test(f.message))).toBe(true);
  });
});

describe('freshness check (real git)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'soothsay-git-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('flags exactly the commits on watched paths after the verified date', async () => {
    const g = (args: string[], env?: Record<string, string>) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
    const dated = (iso: string) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });

    g(['init', '-q']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'Test User']);

    writeFileSync(join(repo, 'watched.txt'), 'v1\n');
    g(['add', 'watched.txt']);
    g(['commit', '-q', '-m', 'initial watched'], dated('2026-01-01T00:00:00'));

    writeFileSync(join(repo, 'watched.txt'), 'v2\n');
    g(['add', 'watched.txt']);
    g(['commit', '-q', '-m', 'update watched'], dated('2026-07-01T00:00:00'));

    // Newer commit that does NOT touch the watched path — must not be counted.
    writeFileSync(join(repo, 'other.txt'), 'x\n');
    g(['add', 'other.txt']);
    g(['commit', '-q', '-m', 'unrelated change'], dated('2026-07-02T00:00:00'));

    const doc = parseMarkdown(
      'README.md',
      '# Watched Area\n\n<!-- fresh: verified=2026-06-01 watch=watched.txt -->\n',
    );
    const findings = await makeFreshnessCheck().run(makeCtx(repo, [doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('warning');
    expect(f.message).toContain('1 commit(s)');
    expect(f.message).toContain('update watched');
    expect(f.message).not.toContain('unrelated change');
  });
});

describe('bless', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soothsay-bless-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const CONTENT = [
    '# One',
    '',
    '<!-- fresh: verified=2026-01-01 watch=a.txt -->',
    '',
    '# Two',
    '',
    '<!-- fresh: verified=2026-02-02 watch=b.txt owner=core -->',
    '',
  ].join('\n');

  it('updates every fresh directive to the given date', () => {
    writeFileSync(join(dir, 'DOC.md'), CONTENT);
    const res = bless(dir, 'DOC.md', { date: '2026-07-04' });
    expect(res.updated).toBe(2);
    const text = readFileSync(join(dir, 'DOC.md'), 'utf8');
    expect(text).not.toContain('2026-01-01');
    expect(text).not.toContain('2026-02-02');
    expect(text.match(/verified=2026-07-04/g)).toHaveLength(2);
    expect(text).toContain('watch=b.txt owner=core');
  });

  it('with a section, updates only the directive under that heading', () => {
    writeFileSync(join(dir, 'SCOPED.md'), CONTENT);
    const res = bless(dir, 'SCOPED.md', { date: '2026-07-04', section: 'two' });
    expect(res.updated).toBe(1);
    const text = readFileSync(join(dir, 'SCOPED.md'), 'utf8');
    expect(text).toContain('verified=2026-01-01');
    expect(text).toContain('verified=2026-07-04 watch=b.txt owner=core');
  });

  it('defaults the date to today', () => {
    writeFileSync(join(dir, 'TODAY.md'), CONTENT);
    const res = bless(dir, 'TODAY.md');
    expect(res.updated).toBe(2);
    const today = new Date().toISOString().slice(0, 10);
    const text = readFileSync(join(dir, 'TODAY.md'), 'utf8');
    expect(text.match(new RegExp(`verified=${today}`, 'g'))).toHaveLength(2);
  });

  it('never touches fresh-looking lines inside fenced code blocks', () => {
    const content = [
      '# Real',
      '',
      '<!-- fresh: verified=2026-01-01 watch=a.txt -->',
      '',
      'Example directive:',
      '',
      '```md',
      '<!-- fresh: verified=2020-05-05 watch=example.txt -->',
      '```',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'FENCED.md'), content);
    const res = bless(dir, 'FENCED.md', { date: '2026-07-04' });
    expect(res.updated).toBe(1);
    const text = readFileSync(join(dir, 'FENCED.md'), 'utf8');
    expect(text).toContain('verified=2026-07-04 watch=a.txt');
    expect(text).toContain('verified=2020-05-05 watch=example.txt');
  });

  it('replaces a time-stamped verified value cleanly', () => {
    writeFileSync(
      join(dir, 'TIMED.md'),
      '# T\n\n<!-- fresh: verified=2026-01-01T09:15 watch=a.txt -->\n',
    );
    const res = bless(dir, 'TIMED.md', { date: '2026-07-04' });
    expect(res.updated).toBe(1);
    const text = readFileSync(join(dir, 'TIMED.md'), 'utf8');
    expect(text).toContain('verified=2026-07-04 watch=a.txt');
    expect(text).not.toContain('T09:15');
  });
});
