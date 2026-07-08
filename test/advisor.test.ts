import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../src/parser/markdown.js';
import { runAiAdvisor, type AdvisorFetch } from '../src/ai/advisor.js';
import type { CheckContext, RepoFacts, SoothsayConfig } from '../src/types.js';

function makeCtx(root: string): CheckContext {
  const repo: RepoFacts = {
    root,
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

const API_RESPONSE = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        findings: [
          {
            kind: 'contradiction',
            file: 'README.md',
            line: 3,
            message: 'README says npm install but CLAUDE.md requires pnpm.',
            suggestion: 'Change to pnpm install.',
          },
          {
            kind: 'vague',
            file: 'CLAUDE.md',
            line: 3,
            message: 'Instruction lacks a checkable command.',
            suggestion: '',
          },
        ],
      }),
    },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 500, output_tokens: 120 },
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'soothsay-ai-'));
  return () => rmSync(root, { recursive: true, force: true });
});

describe('runAiAdvisor', () => {
  it('maps API findings to advisory (never error-severity) findings', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fake: AdvisorFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => API_RESPONSE };
    };
    const result = await runAiAdvisor(makeCtx(root), { apiKey: 'sk-test', fetchFn: fake });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('api.anthropic.com/v1/messages');
    expect(calls[0]!.body.model).toBe('claude-haiku-4-5');
    // structured output requested so parsing is guaranteed
    expect(calls[0]!.body.output_config).toBeDefined();

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.check).toBe('ai-advisory');
    expect(result.findings.every((f) => f.severity !== 'error')).toBe(true);
    expect(result.findings[0]!.location).toEqual({ file: 'README.md', line: 3 });
  });

  it('caches by content hash — identical second run makes no API call', async () => {
    let apiCalls = 0;
    const fake: AdvisorFetch = async () => {
      apiCalls++;
      return { ok: true, status: 200, json: async () => API_RESPONSE };
    };
    const first = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    const second = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    expect(apiCalls).toBe(1);
    expect(first.apiCalls).toBe(1);
    expect(second.apiCalls).toBe(0);
    expect(second.findings).toEqual(first.findings);
    expect(existsSync(join(root, '.soothsay-cache.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, '.soothsay-cache.json'), 'utf8'))).toBeTypeOf(
      'object',
    );
  });

  it('ignores corrupted cache entries and refetches', async () => {
    let apiCalls = 0;
    const fake: AdvisorFetch = async () => {
      apiCalls++;
      return { ok: true, status: 200, json: async () => API_RESPONSE };
    };
    const first = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    expect(first.apiCalls).toBe(1);

    // Corrupt the cached entry: findings must be an array, not a string.
    const cachePath = join(root, '.soothsay-cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    for (const key of Object.keys(cache)) cache[key] = 'corrupted';
    writeFileSync(cachePath, JSON.stringify(cache));

    const second = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    expect(second.apiCalls).toBe(1); // cache miss — refetched
    expect(apiCalls).toBe(2);
    expect(second.findings).toHaveLength(2);
  });

  it('refuses to run when the estimated tokens exceed the budget', async () => {
    let apiCalls = 0;
    const fake: AdvisorFetch = async () => {
      apiCalls++;
      return { ok: true, status: 200, json: async () => API_RESPONSE };
    };
    const result = await runAiAdvisor(makeCtx(root), {
      apiKey: 'k',
      fetchFn: fake,
      budgetTokens: 10, // far below the docs' size
    });
    expect(apiCalls).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('info');
    expect(result.findings[0]!.message).toMatch(/budget/i);
  });

  it('returns an info finding instead of throwing on API errors', async () => {
    const fake: AdvisorFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }),
    });
    const result = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('info');
    expect(result.findings[0]!.message).toContain('429');
  });

  it('returns an info finding when no API key is available', async () => {
    const result = await runAiAdvisor(makeCtx(root), { apiKey: undefined });
    expect(result.findings[0]!.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('returns an info finding (never throws) when the model declines the request', async () => {
    const fake: AdvisorFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [], stop_reason: 'refusal' }),
    });
    const result = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('info');
    expect(result.findings[0]!.message).toMatch(/declined/i);
  });

  it('returns an info finding when the model output is not valid JSON', async () => {
    const fake: AdvisorFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: 'not json at all' }],
        stop_reason: 'end_turn',
      }),
    });
    const result = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('info');
    expect(result.findings[0]!.message).toMatch(/unparseable/i);
  });

  it('maps a contradiction to warning and other kinds to info severity', async () => {
    const fake: AdvisorFetch = async () => ({ ok: true, status: 200, json: async () => API_RESPONSE });
    const result = await runAiAdvisor(makeCtx(root), { apiKey: 'k', fetchFn: fake });
    const contradiction = result.findings.find((f) => f.message.includes('[contradiction]'))!;
    const vague = result.findings.find((f) => f.message.includes('[vague]'))!;
    expect(contradiction.severity).toBe('warning');
    expect(vague.severity).toBe('info');
  });
});
