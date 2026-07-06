import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../src/parser/markdown.js';
import { pathExists } from '../src/checks/pathExists.js';
import { linkValid } from '../src/checks/linkValid.js';
import { skillResources } from '../src/checks/skillResources.js';
import type {
  CheckContext,
  DocFile,
  RepoFacts,
  SoothsayConfig,
} from '../src/types.js';

const config: SoothsayConfig = { docs: [], ignore: [], disable: [], asserts: [] };

function repoOf(files: string[], dirs: string[] = [], root = '/fake'): RepoFacts {
  const set = new Set(files);
  const filesLower = new Map<string, string>();
  for (const f of files) filesLower.set(f.toLowerCase(), f);
  return {
    root,
    files: set,
    dirs: new Set(dirs),
    filesLower,
    packageJson: null,
    packageScripts: new Set(),
    lockfiles: [],
    packageManager: null,
    packageManagerSource: null,
  };
}

function ctxOf(docs: DocFile[], files: string[], dirs: string[] = [], root = '/fake'): CheckContext {
  return { repo: repoOf(files, dirs, root), docs, config };
}

describe('pathExists', () => {
  it('has the right name', () => {
    expect(pathExists.name).toBe('path-exists');
  });

  it('accepts an existing path referenced in inline code', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Run `scripts/sync.py` daily.\n');
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py']));
    expect(findings).toEqual([]);
  });

  it('flags a case mismatch as a high-confidence error with a suggestion', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Run `Scripts/Sync.py` daily.\n');
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py']));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('path-exists');
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.suggestion).toContain('scripts/sync.py');
    expect(f.location).toEqual({ file: 'CLAUDE.md', line: 1 });
  });

  it('warns when a missing path sits under a known top-level directory', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'See `scripts/gone.py` for details.\n');
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py']));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('warning');
    expect(f.confidence).toBe('medium');
    expect(f.message).toContain('scripts/gone.py');
    expect(f.message).toContain('does not exist');
  });

  it('reports unknown-looking paths as low-confidence info only', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Maybe `vendor/thing.md` somewhere.\n');
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py']));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.confidence).toBe('low');
  });

  it('skips urls, flags, globs, and commands', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      'Use `https://ex.com/a.md` and `--flag` and `src/**/*.ts` and `npm run build` and `foo:bar/baz.md`.\n',
    );
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py']));
    expect(findings).toEqual([]);
  });

  it('strips ./ prefixes and trailing punctuation, and skips paths outside the repo', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      'Run `./scripts/sync.py` and `scripts/sync.py,` but not `../elsewhere/x.md`.\n',
    );
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py']));
    expect(findings).toEqual([]);
  });

  it('treats an existing directory (even an empty one) as a valid reference', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Capture into `brain/inbox/` then `brain/notes`.\n');
    const findings = await pathExists.run(
      ctxOf([doc], [], ['brain', 'brain/inbox', 'brain/notes']),
    );
    expect(findings).toEqual([]);
  });

  it('resolves candidates relative to the doc directory too', async () => {
    const doc = parseMarkdown('docs/guide.md', 'See `assets/x.md` and `sub/dir/`.\n');
    const findings = await pathExists.run(
      ctxOf([doc], ['docs/assets/x.md'], ['docs/sub/dir']),
    );
    expect(findings).toEqual([]);
  });

  it('skips placeholder and noise tokens', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      [
        'Use `brain/people/<slug>.md` and `youtube.com/@handle` and `#DIV/0!`.',
        'Also `~/.config/app/settings.md` and `journal/YYYY-MM-DD.md` and `.md`.',
        'And `example.com/watch.md` too.',
      ].join('\n'),
    );
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py']));
    expect(findings).toEqual([]);
  });
});

describe('linkValid', () => {
  it('has the right name', () => {
    expect(linkValid.name).toBe('link-valid');
  });

  it('accepts a link resolved relative to the doc directory', async () => {
    const doc = parseMarkdown('docs/guide.md', 'See [setup](setup.md).\n');
    const findings = await linkValid.run(ctxOf([doc], ['docs/guide.md', 'docs/setup.md']));
    expect(findings).toEqual([]);
  });

  it('accepts a link resolved from the repo root', async () => {
    const doc = parseMarkdown('docs/guide.md', 'See [sync](scripts/sync.py).\n');
    const findings = await linkValid.run(ctxOf([doc], ['docs/guide.md', 'scripts/sync.py']));
    expect(findings).toEqual([]);
  });

  it('flags a broken relative link as a high-confidence error', async () => {
    const doc = parseMarkdown('docs/guide.md', 'See [gone](missing.md).\n');
    const findings = await linkValid.run(ctxOf([doc], ['docs/guide.md']));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('link-valid');
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toContain('missing.md');
    expect(f.location.file).toBe('docs/guide.md');
  });

  it('flags a broken same-file anchor and accepts a valid one', async () => {
    const doc = parseMarkdown(
      'README.md',
      '# Real Heading\n\n[ok](#real-heading) and [bad](#nope)\n',
    );
    const findings = await linkValid.run(ctxOf([doc], ['README.md']));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toContain('nope');
  });

  it('validates cross-file anchors against the target doc headings', async () => {
    const a = parseMarkdown('a.md', '[ok](b.md#setup) and [bad](b.md#missing)\n');
    const b = parseMarkdown('b.md', '## Setup\n\ntext\n');
    const findings = await linkValid.run(ctxOf([a, b], ['a.md', 'b.md']));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.message).toContain('b.md');
    expect(f.message).toContain('missing');
  });

  it('skips anchor validation when the target md is not a scanned doc', async () => {
    const a = parseMarkdown('a.md', '[x](b.md#whatever)\n');
    const findings = await linkValid.run(ctxOf([a], ['a.md', 'b.md']));
    expect(findings).toEqual([]);
  });

  it('skips external and mailto links', async () => {
    const doc = parseMarkdown(
      'README.md',
      '[x](https://example.com/a.md) [y](mailto:a@b.co) [z](http://ex.com)\n',
    );
    const findings = await linkValid.run(ctxOf([doc], []));
    expect(findings).toEqual([]);
  });

  it('flags case-mismatched link targets with a suggestion', async () => {
    const doc = parseMarkdown('README.md', '[g](Docs/Setup.md)\n');
    const findings = await linkValid.run(ctxOf([doc], ['README.md', 'docs/setup.md']));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.suggestion).toContain('docs/setup.md');
  });

  it('accepts links to existing directories (root-relative and doc-relative)', async () => {
    const doc = parseMarkdown(
      'a/b/c/doc.md',
      'See [schemas](archive/schemas/) and [posts](../../../content/linkedin/posts/2026).\n',
    );
    const findings = await linkValid.run(
      ctxOf([doc], ['a/b/c/doc.md'], ['archive/schemas', 'content/linkedin/posts/2026']),
    );
    expect(findings).toEqual([]);
  });

  it('accepts same-file anchors that differ only in chars GitHub keeps (lenient match)', async () => {
    const doc = parseMarkdown(
      'README.md',
      '## 1. Risk — Heat Matrix 5×5\n\n[jump](#1-risk--heat-matrix-5×5)\n',
    );
    const findings = await linkValid.run(ctxOf([doc], ['README.md']));
    expect(findings).toEqual([]);
  });

  it('validates anchors against setext headings', async () => {
    const doc = parseMarkdown(
      'README.md',
      'Intro Title\n===========\n\n[ok](#intro-title) [bad](#zzz)\n',
    );
    const findings = await linkValid.run(ctxOf([doc], ['README.md']));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('zzz');
  });

  it('flags a broken reference-style link and accepts a valid one', async () => {
    const doc = parseMarkdown('a.md', 'See [api][ref] and [ok][good].\n\n[ref]: docs/api.md\n[good]: docs/good.md\n');
    const findings = await linkValid.run(ctxOf([doc], ['a.md', 'docs/good.md']));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('docs/api.md');
  });

  it('accepts cross-file anchors via lenient matching but still flags real misses', async () => {
    const a = parseMarkdown(
      'a.md',
      '[ok](b.md#1-risk--heat-matrix-5×5) and [bad](b.md#totally-absent)\n',
    );
    const b = parseMarkdown('b.md', '## 1. Risk — Heat Matrix 5×5\n');
    const findings = await linkValid.run(ctxOf([a, b], ['a.md', 'b.md']));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('totally-absent');
  });
});

describe('skillResources', () => {
  it('has the right name', () => {
    expect(skillResources.name).toBe('skill-resource-exists');
  });

  it('ignores docs that are not SKILL.md', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'See `zzz.md`.\n');
    const findings = await skillResources.run(ctxOf([doc], ['CLAUDE.md']));
    expect(findings).toEqual([]);
  });

  it('accepts resources found in the skill directory (inline code and links)', async () => {
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      'See `reference.md` and [ref](./docs/ref.md).\n',
    );
    const files = [
      '.claude/skills/foo/SKILL.md',
      '.claude/skills/foo/reference.md',
      '.claude/skills/foo/docs/ref.md',
    ];
    const findings = await skillResources.run(ctxOf([doc], files));
    expect(findings).toEqual([]);
  });

  it('downgrades a resource that exists only at the repo root to info/low', async () => {
    const doc = parseMarkdown('.claude/skills/foo/SKILL.md', 'Run `scripts/sync.py`.\n');
    const files = ['.claude/skills/foo/SKILL.md', 'scripts/sync.py'];
    const findings = await skillResources.run(ctxOf([doc], files));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('skill-resource-exists');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe('low');
    expect(f.message).toContain('scripts/sync.py');
    expect(f.suggestion).toBeDefined();
  });

  it('downgrades a reference to a repo-root directory to info/low', async () => {
    const doc = parseMarkdown('.claude/skills/foo/SKILL.md', 'Data lives in `playground/gmail/`.\n');
    const findings = await skillResources.run(
      ctxOf([doc], ['.claude/skills/foo/SKILL.md'], ['playground', 'playground/gmail']),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.confidence).toBe('low');
  });

  it('accepts a directory inside the skill dir', async () => {
    const doc = parseMarkdown('.claude/skills/foo/SKILL.md', 'Templates in `templates/`.\n');
    const findings = await skillResources.run(
      ctxOf([doc], ['.claude/skills/foo/SKILL.md'], ['.claude/skills/foo/templates']),
    );
    expect(findings).toEqual([]);
  });

  it('skips placeholder tokens in skill resources', async () => {
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      'Write to `brain/people/<slug>.md`.\n\n```bash\npython run.py output/YYYY-MM-DD.json\n```\n',
    );
    const findings = await skillResources.run(
      ctxOf([doc], ['.claude/skills/foo/SKILL.md', '.claude/skills/foo/run.py']),
    );
    expect(findings).toEqual([]);
  });

  it('errors when a resource is missing everywhere', async () => {
    const doc = parseMarkdown('.claude/skills/foo/SKILL.md', 'Run `missing.py`.\n');
    const findings = await skillResources.run(
      ctxOf([doc], ['.claude/skills/foo/SKILL.md']),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toContain('missing.py');
    expect(f.message).toContain('does not exist');
  });

  it('treats only the first non-flag interpreter argument as a resource', async () => {
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      '# Foo\n\n```bash\npython a.py b.md --out c.md\n```\n',
    );
    const files = ['.claude/skills/foo/SKILL.md', '.claude/skills/foo/a.py'];
    const findings = await skillResources.run(ctxOf([doc], files));
    expect(findings).toEqual([]);

    const missing = await skillResources.run(
      ctxOf([doc], ['.claude/skills/foo/SKILL.md']),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain('a.py');
  });

  it('finds path tokens in code blocks after commands like python', async () => {
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      '# Foo Skill\n\nRun:\n\n```bash\npython run.py --all\npython gone.py\n```\n',
    );
    const files = ['.claude/skills/foo/SKILL.md', '.claude/skills/foo/run.py'];
    const findings = await skillResources.run(ctxOf([doc], files));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.message).toContain('gone.py');
    expect(f.location).toEqual({ file: '.claude/skills/foo/SKILL.md', line: 7 });
  });
});

describe('gitignore awareness in path checks', () => {
  let gitRoot: string;

  beforeAll(() => {
    gitRoot = mkdtempSync(join(tmpdir(), 'soothsay-ignored-checks-'));
    execFileSync('git', ['init', '-q'], { cwd: gitRoot });
    writeFileSync(join(gitRoot, '.gitignore'), 'token.json\narchive/emails/\nplayground/\n');
    writeFileSync(join(gitRoot, 'scripts-placeholder.txt'), 'x\n');
  });

  afterAll(() => rmSync(gitRoot, { recursive: true, force: true }));

  it('pathExists skips gitignored missing paths but flags real drift', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      'Auth needs `token.json`. Mail in `archive/emails/x.txt`. See `scripts/gone.py`.\n',
    );
    const findings = await pathExists.run(
      ctxOf([doc], ['scripts/sync.py'], [], gitRoot),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('scripts/gone.py');
  });

  it('pathExists skips a gitignored directory reference (dir-only pattern)', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Emails live in `archive/emails/`.\n');
    const findings = await pathExists.run(ctxOf([doc], ['scripts/sync.py'], [], gitRoot));
    expect(findings).toEqual([]);
  });

  it('skillResources skips gitignored missing resources', async () => {
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      'Reads `playground/data.json` and `really/missing.py`.\n',
    );
    const findings = await skillResources.run(
      ctxOf([doc], ['.claude/skills/foo/SKILL.md'], [], gitRoot),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('really/missing.py');
  });
});

describe('skillResources output-dir convention', () => {
  it('downgrades bare single-segment dir references like `tasks/` to info/low', async () => {
    const doc = parseMarkdown(
      '.claude/skills/prd/SKILL.md',
      '# PRD\n\nSave output to `tasks/` as markdown. Also see `references/deep/x.md`.\n',
    );
    const findings = await skillResources.run(ctxOf([doc], [], []));
    const tasks = findings.find((f) => f.message.includes('tasks/'));
    expect(tasks?.severity).toBe('info');
    expect(tasks?.confidence).toBe('low');
    const nested = findings.find((f) => f.message.includes('references/deep/x.md'));
    expect(nested?.severity).toBe('error');
  });
});
