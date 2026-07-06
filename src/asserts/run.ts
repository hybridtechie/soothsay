/**
 * Layer 2: sidecar assertions. Asserts live in soothsay.yml — not in the
 * agent docs themselves — so context files stay token-lean. The optional
 * `doc:` anchor ties an assert to the prose section it enforces; a dead
 * anchor is itself an error, which is how sidecar drift is caught.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import YAML from 'yaml';
import { parseMarkdown } from '../parser/markdown.js';
import { isNegativeExample } from '../checks/negation.js';
import type {
  AssertRule,
  Check,
  CheckContext,
  DocFile,
  Finding,
  Location,
} from '../types.js';

/** Rule-level findings point at the sidecar itself. */
export const RULE_LOCATION: Location = { file: 'soothsay.yml', line: 1 };

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const IMPORT_RES = [
  /from\s+['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\s*\(\s*['"]([^'"]+)['"]/g,
];

// ---------------------------------------------------------------------------
// Shared helpers (also used by assert-conflicts)
// ---------------------------------------------------------------------------

/** Docs a rule applies to: scope glob matched against doc paths, or all. */
export function docsInScope(docs: DocFile[], scope?: string): DocFile[] {
  if (!scope) return docs;
  const isMatch = picomatch(scope, { dot: true });
  return docs.filter((d) => isMatch(d.path));
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Split a shell-ish line into command-position segments. */
function segments(line: string): string[] {
  return line
    .split(/&&|;|\|/)
    .map(normalize)
    .filter((s) => s.length > 0);
}

/** `cmd` counts as present only at the start of a segment. */
function segmentMatches(segment: string, cmd: string): boolean {
  return segment === cmd || segment.startsWith(`${cmd} `);
}

/** All lines of a doc (fenced blocks + inline code) where `cmd` appears. */
export function findCommandLines(doc: DocFile, cmd: string): number[] {
  const needle = normalize(cmd);
  const lines: number[] = [];
  for (const block of doc.codeBlocks) {
    const blockLines = block.code.split('\n');
    for (let i = 0; i < blockLines.length; i++) {
      if (segments(blockLines[i] ?? '').some((s) => segmentMatches(s, needle))) {
        // startLine is the opening fence; code starts one line below.
        lines.push(block.startLine + 1 + i);
      }
    }
  }
  for (const inline of doc.inlineCodes) {
    if (segments(inline.code).some((s) => segmentMatches(s, needle))) {
      lines.push(inline.line);
    }
  }
  return lines;
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j] ?? 0;
      prev[j] = Math.min(
        cur + 1,
        (prev[j - 1] ?? 0) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = cur;
    }
  }
  return prev[b.length] ?? 0;
}

// ---------------------------------------------------------------------------
// Individual rule checks
// ---------------------------------------------------------------------------

function checkAnchor(rule: AssertRule, ctx: CheckContext, findings: Finding[]): void {
  if (!rule.doc) return;
  const hash = rule.doc.indexOf('#');
  const file = hash >= 0 ? rule.doc.slice(0, hash) : rule.doc;
  const slug = hash >= 0 ? rule.doc.slice(hash + 1) : '';

  const doc = ctx.docs.find((d) => d.path === file);
  if (!doc) {
    findings.push({
      check: 'assert-anchor',
      severity: 'error',
      confidence: 'high',
      location: RULE_LOCATION,
      message: `assert "${rule.id}" is anchored to ${rule.doc} but the file is not scanned`,
    });
    return;
  }
  if (slug && !doc.headings.some((h) => h.slug === slug)) {
    const near = doc.headings
      .map((h) => h.slug)
      .sort((a, b) => levenshtein(a, slug) - levenshtein(b, slug))
      .slice(0, 3);
    findings.push({
      check: 'assert-anchor',
      severity: 'error',
      confidence: 'high',
      location: RULE_LOCATION,
      message: `assert "${rule.id}" is anchored to ${rule.doc} but the heading does not exist`,
      ...(near.length > 0
        ? { suggestion: `Did you mean: ${near.map((s) => `#${s}`).join(', ')}?` }
        : {}),
    });
  }
}

function checkForbidCommand(rule: AssertRule, ctx: CheckContext, findings: Finding[]): void {
  const scoped = docsInScope(ctx.docs, rule.scope);
  for (const cmd of rule.forbid_command ?? []) {
    for (const doc of scoped) {
      for (const line of findCommandLines(doc, cmd)) {
        const negative = isNegativeExample(doc, line, cmd);
        findings.push({
          check: 'asserts',
          severity: negative ? 'info' : 'error',
          confidence: negative ? 'low' : 'high',
          location: { file: doc.path, line },
          message:
            `\`${cmd}\` is forbidden by assert "${rule.id}" but appears in ${doc.path}` +
            (negative ? ' (appears in a negative example)' : ''),
          ...(rule.source ? { suggestion: `Source of truth: ${rule.source}` } : {}),
        });
      }
    }
  }
}

function checkRequireCommand(rule: AssertRule, ctx: CheckContext, findings: Finding[]): void {
  const scoped = docsInScope(ctx.docs, rule.scope);
  const scopeDesc = rule.scope ? ` matching ${rule.scope}` : '';
  for (const cmd of rule.require_command ?? []) {
    const found = scoped.some((doc) => findCommandLines(doc, cmd).length > 0);
    if (!found) {
      findings.push({
        check: 'asserts',
        severity: 'error',
        confidence: 'high',
        location: RULE_LOCATION,
        message: `\`${cmd}\` is required by assert "${rule.id}" but not found in any scanned doc${scopeDesc}`,
      });
    }
  }
}

function checkRequireFile(rule: AssertRule, ctx: CheckContext, findings: Finding[]): void {
  for (const path of rule.require_file ?? []) {
    if (ctx.repo.files.has(path)) continue;
    const actual = ctx.repo.filesLower.get(path.toLowerCase());
    findings.push({
      check: 'asserts',
      severity: 'error',
      confidence: 'high',
      location: RULE_LOCATION,
      message: `${path} is required by assert "${rule.id}" but does not exist`,
      ...(actual ? { suggestion: `Did you mean ${actual}? (case mismatch)` } : {}),
    });
  }
}

function checkForbidImport(rule: AssertRule, ctx: CheckContext, findings: Finding[]): void {
  if (!rule.forbid_import) return;
  const inMatch = picomatch(rule.in ?? '**', { dot: true });
  const exceptMatchers = (rule.except ?? []).map((g) => picomatch(g, { dot: true }));
  const specMatch = picomatch(rule.forbid_import, { dot: true });

  for (const file of ctx.repo.files) {
    if (!SOURCE_EXTS.some((ext) => file.endsWith(ext))) continue;
    if (!inMatch(file)) continue;
    if (exceptMatchers.some((m) => m(file))) continue;

    let content: string;
    try {
      content = readFileSync(join(ctx.repo.root, file), 'utf8');
    } catch {
      continue;
    }
    for (const re of IMPORT_RES) {
      for (const m of content.matchAll(re)) {
        const spec = m[1];
        if (spec === undefined || !specMatch(spec)) continue;
        const line = content.slice(0, m.index).split('\n').length;
        findings.push({
          check: 'asserts',
          severity: 'error',
          confidence: 'high',
          location: { file, line },
          message: `"${spec}" is imported in ${file} but forbidden by assert "${rule.id}"`,
        });
      }
    }
  }
}

function resolveDotPath(value: unknown, dotPath: string): unknown {
  let cur = value;
  for (const key of dotPath.split('.')) {
    if (cur !== null && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function checkValueMatchesSource(rule: AssertRule, ctx: CheckContext, findings: Finding[]): void {
  if (!rule.source || rule.expect === undefined) return;
  const hash = rule.source.indexOf('#');
  const file = hash >= 0 ? rule.source.slice(0, hash) : rule.source;
  const dotPath = hash >= 0 ? rule.source.slice(hash + 1) : '';

  let value: unknown;
  try {
    const text = readFileSync(join(ctx.repo.root, file), 'utf8');
    const parsed: unknown = /\.ya?ml$/i.test(file) ? YAML.parse(text) : JSON.parse(text);
    value = dotPath ? resolveDotPath(parsed, dotPath) : parsed;
  } catch {
    value = undefined;
  }

  if (value === undefined) {
    findings.push({
      check: 'asserts',
      severity: 'error',
      confidence: 'high',
      location: RULE_LOCATION,
      message: `source of truth ${rule.source} not found`,
    });
    return;
  }

  // YAML scalars make expect a number/boolean; compare both sides as strings.
  const expected = String(rule.expect);
  const actual = String(value);
  // "pnpm@9.1.0" satisfies expect "pnpm": compare the part before '@' when
  // the expectation does not pin a version.
  const comparable =
    actual.includes('@') && !expected.includes('@')
      ? (actual.split('@')[0] ?? actual)
      : actual;
  if (comparable !== expected) {
    findings.push({
      check: 'asserts',
      severity: 'error',
      confidence: 'high',
      location: RULE_LOCATION,
      message: `${rule.source} is "${actual}" but assert "${rule.id}" expects "${expected}"`,
    });
  }
}

function checkToolsSubset(rule: AssertRule, ctx: CheckContext, findings: Finding[]): void {
  if (!rule.agent) return;
  let text: string;
  try {
    text = readFileSync(join(ctx.repo.root, rule.agent), 'utf8');
  } catch {
    findings.push({
      check: 'asserts',
      severity: 'error',
      confidence: 'high',
      location: RULE_LOCATION,
      message: `agent file ${rule.agent} referenced by assert "${rule.id}" does not exist`,
    });
    return;
  }

  const doc = parseMarkdown(rule.agent, text);
  const raw = doc.frontmatter?.['tools'];
  const tools =
    typeof raw === 'string'
      ? raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      : Array.isArray(raw)
        ? raw.filter((t): t is string => typeof t === 'string')
        : [];
  const allowed = rule.allowed ?? [];
  for (const tool of tools) {
    if (!allowed.includes(tool)) {
      findings.push({
        check: 'asserts',
        severity: 'error',
        confidence: 'high',
        location: RULE_LOCATION,
        message: `agent ${rule.agent} has tool ${tool} but assert "${rule.id}" allows only [${allowed.join(', ')}]`,
      });
    }
  }
}

function hasRecognizedKeys(rule: AssertRule): boolean {
  return Boolean(
    rule.forbid_command ||
      rule.require_command ||
      rule.require_file ||
      rule.forbid_import ||
      (rule.source && rule.expect !== undefined) ||
      rule.agent,
  );
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export const assertsCheck: Check = {
  name: 'asserts',
  run(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const rule of ctx.config.asserts) {
      checkAnchor(rule, ctx, findings);
      if (!hasRecognizedKeys(rule)) {
        findings.push({
          check: 'asserts',
          severity: 'warning',
          confidence: 'high',
          location: RULE_LOCATION,
          message: `assert "${rule.id}" has no recognized assertion keys`,
        });
        continue;
      }
      checkForbidCommand(rule, ctx, findings);
      checkRequireCommand(rule, ctx, findings);
      checkRequireFile(rule, ctx, findings);
      checkForbidImport(rule, ctx, findings);
      checkValueMatchesSource(rule, ctx, findings);
      checkToolsSubset(rule, ctx, findings);
    }
    return findings;
  },
};
