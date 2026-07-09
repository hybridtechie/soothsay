import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown.js';
import {
  buildAdvisoryTask,
  ingestAdvisories,
  mapAdvisories,
  ADVISORY_SYSTEM_PROMPT,
} from '../src/ai/host-agent.js';
import type { CheckContext, RepoFacts, SoothsayConfig } from '../src/types.js';

function makeCtx(): CheckContext {
  const repo: RepoFacts = {
    root: '/repo',
    files: new Set(['CLAUDE.md', 'README.md']),
    dirs: new Set(),
    filesLower: new Map(),
    packageJson: null,
    packageScripts: new Set(),
    lockfiles: [],
    packageManager: null,
    packageManagerSource: null,
  };
  const config: SoothsayConfig = { docs: [], ignore: [], disable: [], asserts: [] };
  return {
    repo,
    config,
    docs: [
      parseMarkdown('CLAUDE.md', '# Rules\n\nAlways use pnpm.\n'),
      parseMarkdown('README.md', '# Readme\n\nInstall with npm install.\n'),
    ],
  };
}

describe('buildAdvisoryTask', () => {
  it('emits a self-contained review task with the shared system prompt and a numbered corpus', () => {
    const task = buildAdvisoryTask(makeCtx());

    expect(task.task).toBe('advisory-review');
    expect(task.system).toBe(ADVISORY_SYSTEM_PROMPT);
    expect(task.docCount).toBe(2);

    // Corpus carries every doc, headed by its repo-relative path, with 1-based
    // line numbers so the reviewer can cite exact locations.
    expect(task.corpus).toContain('=== CLAUDE.md ===');
    expect(task.corpus).toContain('=== README.md ===');
    expect(task.corpus).toContain('1: # Rules');
    expect(task.corpus).toContain('3: Always use pnpm.');
    expect(task.corpus).toContain('1: # Readme');
  });

  it('carries a JSON schema the returned findings must conform to', () => {
    const task = buildAdvisoryTask(makeCtx());
    const schema = task.schema as {
      properties: { findings: { items: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.findings.items.properties).toHaveProperty('kind');
    expect(schema.properties.findings.items.properties).toHaveProperty('file');
    expect(schema.properties.findings.items.properties).toHaveProperty('line');
  });
});

describe('mapAdvisories', () => {
  it('maps contradiction to warning and other kinds to info, tagging the check', () => {
    const findings = mapAdvisories([
      { kind: 'contradiction', file: 'README.md', line: 3, message: 'npm vs pnpm', suggestion: 'use pnpm' },
      { kind: 'vague', file: 'CLAUDE.md', line: 3, message: 'no command' },
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      check: 'ai-advisory',
      severity: 'warning',
      confidence: 'low',
      message: '[contradiction] npm vs pnpm',
      location: { file: 'README.md', line: 3 },
      suggestion: 'use pnpm',
    });
    expect(findings[1]!.severity).toBe('info');
    expect(findings[1]!.message).toBe('[vague] no command');
    // No suggestion field when the reviewer gave none.
    expect(findings[1]).not.toHaveProperty('suggestion');
  });

  it('coerces non-positive line numbers to 1', () => {
    const [f] = mapAdvisories([{ kind: 'untyped_claim', file: 'X.md', line: 0, message: 'm' }]);
    expect(f!.location.line).toBe(1);
  });
});

describe('ingestAdvisories', () => {
  it('accepts the { findings: [...] } envelope from a host agent', () => {
    const findings = ingestAdvisories({
      findings: [
        { kind: 'contradiction', file: 'README.md', line: 3, message: 'conflict', suggestion: 's' },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.check).toBe('ai-advisory');
  });

  it('accepts a bare findings array too', () => {
    const findings = ingestAdvisories([
      { kind: 'vague', file: 'CLAUDE.md', line: 1, message: 'unclear' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
  });

  it('returns an empty list (not an error) when the agent found nothing', () => {
    expect(ingestAdvisories({ findings: [] })).toEqual([]);
    expect(ingestAdvisories([])).toEqual([]);
  });

  it('drops malformed items but keeps the valid ones', () => {
    const findings = ingestAdvisories({
      findings: [
        { kind: 'contradiction', file: 'A.md', line: 2, message: 'real' },
        { kind: 'not-a-kind', file: 'B.md', line: 1, message: 'bad kind' },
        { file: 'C.md', line: 1, message: 'no kind' },
        { kind: 'vague', line: 1, message: 'no file' },
        { kind: 'vague', file: 'D.md', message: 'no line' },
        'totally wrong',
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.location.file).toBe('A.md');
  });

  it('never throws on malformed input — yields a single info finding', () => {
    for (const bad of ['a string', 42, null, {}, { findings: 'nope' }]) {
      const findings = ingestAdvisories(bad);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('info');
      expect(findings[0]!.check).toBe('ai-advisory');
    }
  });
});
