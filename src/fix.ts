/**
 * `check --fix`: apply the machine-safe rewrites that checks attach to
 * findings. A fix is a single-line first-occurrence substring replacement —
 * deliberately dumb, so a fix that no longer matches the file (edited since
 * the scan, or shadowed by an earlier fix on the same line) is skipped
 * rather than guessed at. Skipped findings simply survive the re-run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './types.js';

/**
 * Rewrite a doc token to the repo's actual casing. `token` is the path as
 * written in the doc (may be `./`-prefixed, `../`-prefixed, or doc-relative);
 * `actual` is the true repo-relative path it resolved to. Segments are
 * matched tail-first case-insensitively so the token keeps its own shape and
 * only its casing changes. Returns null when the segments don't line up
 * (then no fix is offered) or the token is already correct.
 */
export function caseCorrectToken(token: string, actual: string): string | null {
  const tSegs = token.split('/');
  const aSegs = actual.split('/');
  const out = [...tSegs];
  let ai = aSegs.length - 1;
  for (let ti = tSegs.length - 1; ti >= 0; ti--) {
    const seg = tSegs[ti]!;
    if (seg === '' || seg === '.' || seg === '..') continue;
    const a = aSegs[ai];
    if (a === undefined || a.toLowerCase() !== seg.toLowerCase()) return null;
    out[ti] = a;
    ai--;
  }
  const fixed = out.join('/');
  return fixed === token ? null : fixed;
}

export interface FixResult {
  /** Findings whose fix was actually applied. */
  applied: Finding[];
  /** Repo-relative paths of the files modified, sorted. */
  files: string[];
}

/** Apply every applicable fix among `findings` to the files under `root`. */
export function applyFixes(root: string, findings: Finding[]): FixResult {
  // Dedupe identical rewrites (two checks can flag the same token) and
  // group by file so each file is read and written once.
  const seen = new Set<string>();
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.fix) continue;
    const key = `${f.fix.file}\0${f.fix.line}\0${f.fix.from}\0${f.fix.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byFile.set(f.fix.file, [...(byFile.get(f.fix.file) ?? []), f]);
  }

  const applied: Finding[] = [];
  const files: string[] = [];
  for (const [file, fixes] of byFile) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    let changed = false;
    for (const f of fixes.sort((a, b) => a.fix!.line - b.fix!.line)) {
      const idx = f.fix!.line - 1;
      const line = lines[idx];
      if (line === undefined || !line.includes(f.fix!.from)) continue;
      lines[idx] = line.replace(f.fix!.from, f.fix!.to);
      changed = true;
      applied.push(f);
    }
    if (!changed) continue;
    writeFileSync(join(root, file), lines.join('\n'));
    files.push(file);
  }
  return { applied, files: files.sort() };
}
