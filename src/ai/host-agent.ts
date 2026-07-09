import type { CheckContext, DocFile, Finding } from '../types.js';

/**
 * Layer 3 — the host-agent provider.
 *
 * The AI advisory pass is a *task* (review these docs for contradictions,
 * vagueness, and untyped claims) that two providers can execute:
 *
 * - `advisor.ts` calls the Anthropic API directly — for headless CI with an
 *   ANTHROPIC_API_KEY and no agent present.
 * - This module lets the *calling coding agent* be the LLM: `buildAdvisoryTask`
 *   emits the review inputs, the host agent reasons over them, and
 *   `ingestAdvisories` folds its output back into soothsay findings — no API
 *   key, no separate bill, and the reasoning runs on the model already loaded.
 *
 * This file is the single source of truth for the advisory contract (system
 * prompt, output schema, corpus shape, finding mapping); `advisor.ts` imports
 * these so both providers stay in lockstep.
 */

export type AdvisoryKind = 'contradiction' | 'vague' | 'untyped_claim';

const ADVISORY_KINDS: readonly AdvisoryKind[] = ['contradiction', 'vague', 'untyped_claim'];

/** The raw item an advisory reviewer (API or host agent) returns per finding. */
export interface RawAdvisory {
  kind: AdvisoryKind;
  file: string;
  line: number;
  message: string;
  suggestion?: string;
}

export const ADVISORY_SYSTEM_PROMPT = `You review AI-agent instruction files (CLAUDE.md, AGENTS.md, SKILL.md, README) for a verification tool. Report only high-signal issues of three kinds:
- contradiction: two docs (or two places in one doc) give incompatible instructions.
- vague: an instruction an agent cannot act on deterministically (no command, no scope, no criterion).
- untyped_claim: a checkable technical claim (a command, a path, a version) stated only in prose that the repo could verify.
Use the exact repo-relative file paths and 1-based line numbers from the input. Be conservative: silence beats noise.`;

export const ADVISORY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['contradiction', 'vague', 'untyped_claim'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          message: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['kind', 'file', 'line', 'message', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

/** The numbered, path-headed corpus a reviewer reasons over. */
export function buildAdvisoryCorpus(docs: DocFile[]): string {
  return docs
    .map((d) => {
      const numbered = d.lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
      return `=== ${d.path} ===\n${numbered}`;
    })
    .join('\n\n');
}

/** The self-contained review task a host agent (or the API provider) completes. */
export interface AdvisoryTask {
  task: 'advisory-review';
  /** Reviewer instructions — the job to perform. */
  system: string;
  /** The numbered doc corpus to review. */
  corpus: string;
  /** JSON Schema the returned `{ findings: [...] }` must conform to. */
  schema: typeof ADVISORY_OUTPUT_SCHEMA;
  /** How many docs are included, for budgeting/logging. */
  docCount: number;
}

export function buildAdvisoryTask(ctx: CheckContext): AdvisoryTask {
  return {
    task: 'advisory-review',
    system: ADVISORY_SYSTEM_PROMPT,
    corpus: buildAdvisoryCorpus(ctx.docs),
    schema: ADVISORY_OUTPUT_SCHEMA,
    docCount: ctx.docs.length,
  };
}

function info(message: string): Finding {
  return {
    check: 'ai-advisory',
    severity: 'info',
    confidence: 'low',
    message,
    location: { file: '(ai)', line: 1 },
  };
}

/** Map raw advisory items (from any provider) to soothsay Findings. */
export function mapAdvisories(raw: RawAdvisory[]): Finding[] {
  return raw.map((f) => ({
    check: 'ai-advisory',
    // A contradiction is a warning; softer kinds are advisory info. Never error:
    // the AI pass must never fail CI.
    severity: f.kind === 'contradiction' ? ('warning' as const) : ('info' as const),
    confidence: 'low' as const,
    message: `[${f.kind}] ${f.message}`,
    location: { file: f.file, line: f.line > 0 ? f.line : 1 },
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
  }));
}

function isRawAdvisory(v: unknown): v is RawAdvisory {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.kind === 'string' &&
    ADVISORY_KINDS.includes(o.kind as AdvisoryKind) &&
    typeof o.file === 'string' &&
    typeof o.line === 'number' &&
    typeof o.message === 'string' &&
    (o.suggestion === undefined || typeof o.suggestion === 'string')
  );
}

/**
 * Fold a host agent's advisory output into soothsay findings. Accepts either
 * the `{ findings: [...] }` envelope or a bare array. Individual malformed
 * items are dropped; a wholly malformed payload yields a single info finding.
 * Never throws — the advisory layer must never break the caller.
 */
export function ingestAdvisories(raw: unknown): Finding[] {
  let items: unknown;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as { findings?: unknown }).findings)) {
    items = (raw as { findings: unknown[] }).findings;
  } else {
    return [info('AI pass ingest skipped: expected { findings: [...] } or an array of findings.')];
  }
  const valid = (items as unknown[]).filter(isRawAdvisory);
  return mapAdvisories(valid);
}
