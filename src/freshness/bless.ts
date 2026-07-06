import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubSlug, parseMarkdown } from '../parser/markdown.js';
import { parseFreshDirectives } from './directive.js';

/**
 * Directives are one-liners, so a line-level replace of the verified value
 * (date, optionally time-stamped) inside a `fresh:` comment is sufficient.
 */
const VERIFIED_RE = /(fresh:[^>]*verified=)\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?/;

/**
 * Stamp today's date (or opts.date) into the verified= field of every
 * `fresh:` directive in root/relFile. With opts.section, only directives
 * whose nearest-heading slug matches are blessed.
 *
 * Only lines of REAL parsed directives are rewritten — a `fresh:` line
 * inside a fenced code block is documentation, not a directive.
 */
export function bless(
  root: string,
  relFile: string,
  opts?: { date?: string; section?: string },
): { updated: number } {
  const abs = join(root, relFile);
  const text = readFileSync(abs, 'utf8');
  const date = opts?.date ?? new Date().toISOString().slice(0, 10);

  let { directives } = parseFreshDirectives(parseMarkdown(relFile, text));
  if (opts?.section !== undefined) {
    const wanted = githubSlug(opts.section);
    directives = directives.filter(
      (d) => d.sectionSlug === opts.section || d.sectionSlug === wanted,
    );
  }
  const targetLines = new Set(directives.map((d) => d.line));

  const lines = text.split('\n');
  let updated = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!targetLines.has(i + 1)) continue;
    const line = lines[i]!;
    if (!VERIFIED_RE.test(line)) continue;
    lines[i] = line.replace(VERIFIED_RE, `$1${date}`);
    updated++;
  }

  if (updated > 0) writeFileSync(abs, lines.join('\n'));
  return { updated };
}
