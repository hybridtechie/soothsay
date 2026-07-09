import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckContext, Finding } from '../types.js';
import {
  ADVISORY_OUTPUT_SCHEMA,
  ADVISORY_SYSTEM_PROMPT,
  buildAdvisoryCorpus,
  mapAdvisories,
  type RawAdvisory,
} from './host-agent.js';

/**
 * Layer 3 — opt-in AI advisory pass.
 *
 * Design constraints (see VISION.md):
 * - Never CI-blocking: findings are warning/info only, confidence 'low'.
 * - Budgeted: refuses to run past `budgetTokens` (estimated, chars/4).
 * - Cached: content-hash of the prompt; unchanged docs never re-bill.
 * - Zero SDK dependency: raw fetch against the Messages API.
 */

export interface AdvisorFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type AdvisorFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<AdvisorFetchResponse>;

export interface AdvisorOptions {
  apiKey: string | undefined;
  model?: string;
  /** Estimated-input-token ceiling; the call is skipped above it. */
  budgetTokens?: number;
  fetchFn?: AdvisorFetch;
  cacheFile?: string;
}

export interface AdvisorResult {
  findings: Finding[];
  apiCalls: number;
  estimatedTokens: number;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_BUDGET = 150_000;
const CACHE_FILE = '.soothsay-cache.json';

// The advisory contract (system prompt, output schema, corpus shape, finding
// mapping) is owned by host-agent.ts so the API and host-agent providers stay
// in lockstep.

function info(message: string): Finding {
  return {
    check: 'ai-advisory',
    severity: 'info',
    confidence: 'low',
    message,
    location: { file: '(ai)', line: 1 },
  };
}

function readCache(path: string): Record<string, Finding[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Guard against corrupted entries: cached values must be arrays of
    // findings — drop anything else so a bad entry forces a refetch.
    const cache: Record<string, Finding[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) cache[key] = value as Finding[];
    }
    return cache;
  } catch {
    return {};
  }
}

const realFetch: AdvisorFetch = (url, init) => fetch(url, init);

export async function runAiAdvisor(
  ctx: CheckContext,
  opts: AdvisorOptions,
): Promise<AdvisorResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const fetchFn = opts.fetchFn ?? realFetch;
  const cachePath = opts.cacheFile ?? join(ctx.repo.root, CACHE_FILE);

  if (!opts.apiKey) {
    return {
      findings: [info('AI pass skipped: set ANTHROPIC_API_KEY to enable --ai.')],
      apiCalls: 0,
      estimatedTokens: 0,
    };
  }

  const corpus = buildAdvisoryCorpus(ctx.docs);
  const prompt = `Review these agent docs:\n\n${corpus}`;
  const estimatedTokens = Math.ceil((prompt.length + ADVISORY_SYSTEM_PROMPT.length) / 4);

  if (estimatedTokens > budget) {
    return {
      findings: [
        info(
          `AI pass skipped: estimated ~${estimatedTokens} input tokens exceeds the budget of ${budget}. Raise --ai-budget or narrow the doc set.`,
        ),
      ],
      apiCalls: 0,
      estimatedTokens,
    };
  }

  const cacheKey = createHash('sha256').update(`${model}\n${prompt}`).digest('hex');
  const cache = readCache(cachePath);
  const hit = cache[cacheKey];
  if (hit) return { findings: hit, apiCalls: 0, estimatedTokens };

  const response = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: ADVISORY_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: ADVISORY_OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    return {
      findings: [info(`AI pass failed: Anthropic API returned HTTP ${response.status}.`)],
      apiCalls: 1,
      estimatedTokens,
    };
  }

  const body = (await response.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  if (body.stop_reason === 'refusal') {
    return {
      findings: [info('AI pass skipped: the model declined this request.')],
      apiCalls: 1,
      estimatedTokens,
    };
  }
  const text = body.content?.find((b) => b.type === 'text')?.text ?? '{"findings":[]}';

  let parsed: { findings?: RawAdvisory[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      findings: [info('AI pass returned unparseable output; ignoring.')],
      apiCalls: 1,
      estimatedTokens,
    };
  }

  const findings = mapAdvisories(parsed.findings ?? []);

  cache[cacheKey] = findings;
  try {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // cache write failures are non-fatal
  }

  return { findings, apiCalls: 1, estimatedTokens };
}
