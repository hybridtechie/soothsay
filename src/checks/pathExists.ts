import { posix } from 'node:path';
import type { Check, DocFile, Finding, RepoFacts } from '../types.js';
import { filterIgnored } from '../repo/ignored.js';
import { caseCorrectToken } from '../fix.js';

/** Extensions that make a bare (slash-less) token look like a file path. */
const PATH_EXT_RE = /\.(md|ts|js|py|sh|json|yml|yaml|toml|txt|css|html)$/i;

/** Token is nothing but an extension, e.g. `.md`, `.html`. */
const ONLY_EXT_RE = /^\.[a-z0-9]+$/i;

/** First path segment is a bare domain, e.g. `youtube.com/...`. */
const BARE_DOMAIN_RE = /^[a-z0-9-]+\.(com|org|net|io|dev|app|ai|co)$/i;

export interface PathCandidate {
  /** Repo-root-relative candidate path (leading "./" stripped). */
  path: string;
  /** 1-based line in the doc where the token appeared. */
  line: number;
}

/**
 * Placeholder / noise tokens that look path-ish but are not file references:
 * template placeholders (`brain/people/<slug>.md`), emails and handles,
 * spreadsheet errors (`#DIV/0`), home-relative paths, date placeholders
 * (`YYYY-MM-DD.md`), bare extensions (`.md`), and bare-domain pseudo-paths
 * (`youtube.com/watch`).
 */
export function isNoiseToken(t: string): boolean {
  if (t.includes('<') || t.includes('>')) return true; // template placeholder
  if (t.includes('@')) return true; // email / handle
  if (t.startsWith('#')) return true; // anchor / spreadsheet error
  if (t.startsWith('~')) return true; // home-relative
  if (/yyyy/i.test(t)) return true; // date placeholder (YYYY-MM-DD etc.)
  if (ONLY_EXT_RE.test(t)) return true; // just an extension
  const firstSegment = t.split('/')[0] ?? '';
  if (BARE_DOMAIN_RE.test(firstSegment)) return true; // schemeless URL
  return false;
}

/**
 * Clean a raw token and decide whether it looks like a repo file path.
 * Returns the normalized candidate, or null if the token is a URL, glob,
 * flag, command, placeholder, or points outside the repo.
 */
export function candidatePathFrom(raw: string): string | null {
  let t = raw.trim();
  // Strip surrounding quotes.
  while (
    t.length > 1 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    t = t.slice(1, -1);
  }
  // Strip trailing punctuation.
  t = t.replace(/[.,;:!?)\]"']+$/, '');
  if (t.length === 0) return null;
  if (/\s/.test(t)) return null; // commands / prose
  if (t.includes(':')) return null; // URL scheme or scheme-ish token
  if (/[*?{[]/.test(t)) return null; // glob chars
  if (t.startsWith('-')) return null; // command flag
  if (isNoiseToken(t)) return null; // placeholders, handles, domains, ...
  const hasSlash = t.includes('/');
  if (!hasSlash && !PATH_EXT_RE.test(t)) return null;
  if (t.startsWith('./')) t = t.slice(2);
  if (t.startsWith('/')) return null; // absolute — not repo-relative
  if (t === '..' || t.startsWith('../') || t.includes('/../')) return null; // outside repo
  return t.length > 0 ? t : null;
}

/** All path-like candidates from a doc's inline code spans. */
export function candidatePathsFrom(doc: DocFile): PathCandidate[] {
  const out: PathCandidate[] = [];
  for (const ic of doc.inlineCodes) {
    const p = candidatePathFrom(ic.code);
    if (p) out.push({ path: p, line: ic.line });
  }
  return out;
}

/**
 * Resolve a candidate both from the repo root and from the doc's own
 * directory (posix-normalized). Doc-relative resolutions that escape the
 * repo root are dropped.
 */
export function resolveCandidate(docPath: string, target: string): string[] {
  const out = [target];
  const docDir = posix.dirname(docPath);
  if (docDir !== '.' && docDir !== '') {
    const rel = posix.normalize(posix.join(docDir, target));
    if (rel !== target && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/')) {
      out.push(rel);
    }
  }
  return out;
}

/** True when `p` is an existing file or directory (files, dirs, or file prefix). */
export function existsInRepo(repo: RepoFacts, p: string): boolean {
  if (repo.files.has(p)) return true;
  if (repo.dirs.has(p)) return true;
  const prefix = `${p}/`;
  for (const f of repo.files) if (f.startsWith(prefix)) return true;
  return false;
}

export const pathExists: Check = {
  name: 'path-exists',
  run(ctx) {
    const { repo } = ctx;
    const findings: Finding[] = [];

    const topDirs = new Set<string>();
    for (const f of repo.files) {
      const i = f.indexOf('/');
      if (i > 0) topDirs.add(f.slice(0, i));
    }
    for (const d of repo.dirs) {
      const i = d.indexOf('/');
      topDirs.add(i > 0 ? d.slice(0, i) : d);
    }

    // Findings for genuinely-missing paths are deferred so gitignored
    // candidates can be dropped in one batch.
    const pending: { finding: Finding; keys: string[] }[] = [];

    for (const doc of ctx.docs) {
      for (const cand of candidatePathsFrom(doc)) {
        const target = cand.path.replace(/\/+$/, '');
        if (target.length === 0) continue;

        const resolutions = resolveCandidate(doc.path, target);
        if (resolutions.some((r) => existsInRepo(repo, r))) continue;

        const location = { file: doc.path, line: cand.line };
        const actual = resolutions
          .map((r) => repo.filesLower.get(r.toLowerCase()))
          .find((a) => a !== undefined);
        if (actual) {
          const corrected = caseCorrectToken(cand.path, actual);
          findings.push({
            check: 'path-exists',
            severity: 'error',
            confidence: 'high',
            message: `\`${cand.path}\` does not match the file's actual casing`,
            location,
            suggestion: `Did you mean \`${actual}\`?`,
            ...(corrected
              ? { fix: { ...location, from: cand.path, to: corrected } }
              : {}),
          });
          continue;
        }

        const finding: Finding = topDirs.has(target.split('/')[0]!)
          ? {
              check: 'path-exists',
              severity: 'warning',
              confidence: 'medium',
              message: `\`${cand.path}\` is mentioned but does not exist`,
              location,
            }
          : {
              check: 'path-exists',
              severity: 'info',
              confidence: 'low',
              message: `\`${cand.path}\` does not exist in the repo (may not be a file reference)`,
              location,
            };
        pending.push({ finding, keys: resolutions });
      }
    }

    if (pending.length > 0) {
      const ignored = filterIgnored(repo.root, [
        ...new Set(pending.flatMap((p) => p.keys)),
      ]);
      for (const p of pending) {
        if (p.keys.some((k) => ignored.has(k))) continue;
        findings.push(p.finding);
      }
    }
    return findings;
  },
};
