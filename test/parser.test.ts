import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown.js';

const SAMPLE = `---
name: sample
description: A sample skill
tools: Read, Grep
---

# Getting Started

Run \`pnpm test\` before committing. See [the guide](docs/guide.md#setup).

<!-- fresh: verified=2026-07-01 watch=package.json -->

## Package Management

Use pnpm. Never run \`npm install\`.

\`\`\`bash
pnpm install
python scripts/sync.py --all
\`\`\`

Some text with a path reference: \`scripts/helper.sh\`.

<!--
multi-line comment
spanning lines
-->

### Café & Naming!

[external](https://example.com/x.md) and [anchor only](#getting-started)
`;

describe('parseMarkdown', () => {
  const doc = parseMarkdown('CLAUDE.md', SAMPLE);

  it('parses frontmatter into an object', () => {
    expect(doc.frontmatter).toEqual({
      name: 'sample',
      description: 'A sample skill',
      tools: 'Read, Grep',
    });
  });

  it('extracts headings with github-style slugs and line numbers', () => {
    const slugs = doc.headings.map((h) => h.slug);
    expect(slugs).toEqual(['getting-started', 'package-management', 'café--naming']);
    const first = doc.headings[0]!;
    expect(first.depth).toBe(1);
    expect(first.text).toBe('Getting Started');
    expect(doc.lines[first.line - 1]).toContain('# Getting Started');
  });

  it('extracts fenced code blocks with language and line range', () => {
    expect(doc.codeBlocks).toHaveLength(1);
    const block = doc.codeBlocks[0]!;
    expect(block.lang).toBe('bash');
    expect(block.code).toContain('pnpm install');
    expect(block.code).toContain('python scripts/sync.py --all');
    expect(doc.lines[block.startLine - 1]).toContain('```bash');
  });

  it('extracts inline code spans outside fenced blocks only', () => {
    const codes = doc.inlineCodes.map((c) => c.code);
    expect(codes).toContain('pnpm test');
    expect(codes).toContain('npm install');
    expect(codes).toContain('scripts/helper.sh');
    // content inside the fenced block must not be double-counted
    expect(codes).not.toContain('pnpm install');
  });

  it('extracts links with hrefs and line numbers', () => {
    const hrefs = doc.links.map((l) => l.href);
    expect(hrefs).toContain('docs/guide.md#setup');
    expect(hrefs).toContain('https://example.com/x.md');
    expect(hrefs).toContain('#getting-started');
  });

  it('extracts single-line and multi-line html comments', () => {
    const texts = doc.comments.map((c) => c.text.trim());
    expect(texts).toContain('fresh: verified=2026-07-01 watch=package.json');
    expect(texts.some((t) => t.includes('multi-line comment'))).toBe(true);
  });

  it('handles documents without frontmatter', () => {
    const plain = parseMarkdown('x.md', '# Hi\n\nJust text.');
    expect(plain.frontmatter).toBeNull();
    expect(plain.headings).toHaveLength(1);
  });

  it('does not treat a mid-file --- as frontmatter', () => {
    const plain = parseMarkdown('x.md', 'intro\n\n---\n\nkey: value\n\n---\n');
    expect(plain.frontmatter).toBeNull();
  });

  it('ignores headings inside code blocks', () => {
    const tricky = parseMarkdown('x.md', '```md\n# not a heading\n```\n\n# Real\n');
    expect(tricky.headings.map((h) => h.text)).toEqual(['Real']);
  });

  it('survives malformed yaml frontmatter without throwing', () => {
    const bad = parseMarkdown('x.md', '---\n: : :\n  bad: [\n---\n\n# ok\n');
    expect(bad.frontmatter).toBeNull();
    expect(bad.headings.map((h) => h.text)).toEqual(['ok']);
  });
});

describe('parseMarkdown: setext headings', () => {
  it('promotes = and - underlines to h1/h2 with the usual slug logic', () => {
    const doc = parseMarkdown(
      'x.md',
      ['Intro Title', '===========', '', 'prose', '', 'Sub Part', '--', 'more prose'].join('\n'),
    );
    expect(doc.headings).toEqual([
      { depth: 1, text: 'Intro Title', slug: 'intro-title', line: 1 },
      { depth: 2, text: 'Sub Part', slug: 'sub-part', line: 6 },
    ]);
  });

  it('treats --- after a blank line as a thematic break, not a heading', () => {
    const doc = parseMarkdown('x.md', 'para\n\n---\n\nmore\n');
    expect(doc.headings).toEqual([]);
  });

  it('does not promote lines inside fences, after lists, or after ATX headings', () => {
    const fenced = parseMarkdown('x.md', '```\nTitle\n=====\n```\n');
    expect(fenced.headings).toEqual([]);

    const list = parseMarkdown('x.md', '- item one\n---\n');
    expect(list.headings).toEqual([]);

    const atx = parseMarkdown('x.md', '# Real\n----\n');
    expect(atx.headings.map((h) => h.text)).toEqual(['Real']);
  });

  it('deduplicates setext slugs against ATX slugs', () => {
    const doc = parseMarkdown('x.md', '# Setup\n\nSetup\n=====\n');
    expect(doc.headings.map((h) => h.slug)).toEqual(['setup', 'setup-1']);
  });
});

describe('parseMarkdown: link extraction', () => {
  it('resolves reference-style links (full and collapsed) to their definitions', () => {
    const doc = parseMarkdown(
      'x.md',
      [
        'See [the spec][spec] and [guide][].',
        '',
        '[spec]: docs/spec.md',
        '[guide]: <docs/guide.md> "Title"',
      ].join('\n'),
    );
    expect(doc.links).toContainEqual({ text: 'the spec', href: 'docs/spec.md', line: 1 });
    expect(doc.links).toContainEqual({ text: 'guide', href: 'docs/guide.md', line: 1 });
  });

  it('ignores reference usages with no matching definition', () => {
    const doc = parseMarkdown('x.md', 'Just [prose][nothing] here.\n');
    expect(doc.links).toEqual([]);
  });

  it('parses hrefs containing one level of balanced parens', () => {
    const doc = parseMarkdown('x.md', '[t](docs/foo(1).md) and [u](plain.md)\n');
    expect(doc.links.map((l) => l.href)).toEqual(['docs/foo(1).md', 'plain.md']);
  });

  it('still parses titles and angle-bracket hrefs', () => {
    const doc = parseMarkdown('x.md', '[a](docs/x.md "hey") [b](<spaced path.md>)\n');
    expect(doc.links.map((l) => l.href)).toEqual(['docs/x.md', 'spaced path.md']);
  });
});
