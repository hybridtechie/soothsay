import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { parseMarkdown } from './parser/markdown.js';
import { scanRepo } from './repo/scanner.js';
import type { Check, CheckContext, Finding } from './types.js';

/** Gather repo facts, scan and parse the configured docs. */
export async function loadProject(root: string): Promise<CheckContext> {
  const config = loadConfig(root);
  // Facts reflect the whole repo; config.ignore only narrows DOC selection.
  const repo = await scanRepo(root);

  const docPaths = await fg(config.docs, {
    cwd: root,
    ignore: config.ignore,
    onlyFiles: true,
    unique: true,
    caseSensitiveMatch: false,
  });

  const docs = docPaths.sort().map((p) => parseMarkdown(p, readFileSync(join(root, p), 'utf8')));
  return { repo, docs, config };
}

/** Run every enabled check and collect findings, sorted by file/line. */
export async function runChecks(ctx: CheckContext, checks: Check[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  if (ctx.config.configError !== undefined) {
    findings.push({
      check: 'config',
      severity: 'error',
      confidence: 'high',
      message: `soothsay config could not be loaded (${ctx.config.configError}) — defaults are in effect and asserts are NOT active`,
      location: { file: 'soothsay.yml', line: 1 },
    });
  }
  for (const check of checks) {
    if (ctx.config.disable.includes(check.name)) continue;
    findings.push(...(await check.run(ctx)));
  }
  return findings.sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line ||
      a.check.localeCompare(b.check),
  );
}

export interface Verdict {
  errors: number;
  warnings: number;
  infos: number;
  /** Exit non-zero? Default: high-confidence errors only. --strict: any error or warning. */
  failed: boolean;
}

export function verdict(findings: Finding[], strict = false): Verdict {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const infos = findings.filter((f) => f.severity === 'info').length;
  // The AI advisory pass is contractually never CI-blocking (VISION.md);
  // its findings count in the tallies but never in the verdict.
  const blockable = findings.filter((f) => f.check !== 'ai-advisory');
  const blocking = strict
    ? blockable.some((f) => f.severity === 'error' || f.severity === 'warning')
    : blockable.some((f) => f.severity === 'error' && f.confidence === 'high');
  return { errors, warnings, infos, failed: blocking };
}
