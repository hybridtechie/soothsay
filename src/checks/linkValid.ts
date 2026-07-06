import { posix } from 'node:path';
import type { Check, Finding, Heading, RepoFacts } from '../types.js';
import { caseCorrectToken } from '../fix.js';

/** http(s):, mailto:, and any other scheme'd href. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Resolve an href both relative to the doc's directory and relative to the
 * repo root. Returns the distinct candidate repo-relative paths.
 */
function resolveHref(docPath: string, target: string): string[] {
  const docDir = posix.dirname(docPath);
  const relToDoc = posix.normalize(posix.join(docDir, target));
  let relToRoot = posix.normalize(target);
  if (relToRoot.startsWith('./')) relToRoot = relToRoot.slice(2);
  return relToDoc === relToRoot ? [relToDoc] : [relToDoc, relToRoot];
}

/** File or directory target (trailing slash tolerated for directories). */
function targetExists(repo: RepoFacts, p: string): boolean {
  const bare = p.replace(/\/+$/, '');
  return repo.files.has(bare) || repo.dirs.has(bare);
}

/**
 * Lenient anchor form: strip everything outside [a-z0-9]. Our githubSlug
 * drops chars GitHub keeps (e.g. '×'), so an exact slug mismatch may still
 * be a working anchor — accept when the lenient forms agree.
 */
function lenientAnchor(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function anchorMatches(headings: Heading[], anchor: string): boolean {
  if (headings.some((h) => h.slug === anchor)) return true;
  const lenient = lenientAnchor(anchor);
  if (lenient.length === 0) return false;
  return headings.some((h) => lenientAnchor(h.slug) === lenient);
}

export const linkValid: Check = {
  name: 'link-valid',
  run(ctx) {
    const { repo, docs } = ctx;
    const findings: Finding[] = [];
    const docsByPath = new Map(docs.map((d) => [d.path, d]));

    for (const doc of docs) {
      for (const link of doc.links) {
        const href = link.href;
        if (SCHEME_RE.test(href)) continue; // external / mailto / image URL
        const location = { file: doc.path, line: link.line };

        // Same-file anchor.
        if (href.startsWith('#')) {
          const anchor = href.slice(1).toLowerCase();
          if (!anchorMatches(doc.headings, anchor)) {
            findings.push({
              check: 'link-valid',
              severity: 'error',
              confidence: 'high',
              message: `Broken anchor \`${href}\` — no heading with that slug in this file`,
              location,
            });
          }
          continue;
        }

        const hashIdx = href.indexOf('#');
        const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
        const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : null;
        if (pathPart.length === 0) continue;

        const candidates = resolveHref(doc.path, pathPart);
        const resolved = candidates.find((c) => targetExists(repo, c)) ?? null;

        if (!resolved) {
          const actual =
            candidates
              .map((c) => repo.filesLower.get(c.toLowerCase()))
              .find((a) => a !== undefined) ?? null;
          if (actual) {
            // Anchor the rewrite on "](path" so it hits the href, not link
            // text that happens to repeat the same path.
            const corrected = caseCorrectToken(pathPart, actual);
            findings.push({
              check: 'link-valid',
              severity: 'error',
              confidence: 'high',
              message: `Link \`${href}\` does not match the file's actual casing`,
              location,
              suggestion: `Did you mean \`${actual}\`?`,
              ...(corrected
                ? { fix: { ...location, from: `](${pathPart}`, to: `](${corrected}` } }
                : {}),
            });
          } else {
            findings.push({
              check: 'link-valid',
              severity: 'error',
              confidence: 'high',
              message: `Broken link \`${href}\` — target not found`,
              location,
            });
          }
          continue;
        }

        // Cross-file anchor: only validated when the target doc was scanned.
        if (fragment && resolved.endsWith('.md')) {
          const target = docsByPath.get(resolved);
          if (target) {
            const slug = fragment.toLowerCase();
            if (!anchorMatches(target.headings, slug)) {
              findings.push({
                check: 'link-valid',
                severity: 'error',
                confidence: 'high',
                message: `Broken anchor \`#${fragment}\` in \`${resolved}\``,
                location,
              });
            }
          }
        }
      }
    }
    return findings;
  },
};
