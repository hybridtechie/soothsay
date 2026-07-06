import type { DocFile, Finding } from '../types.js';

/**
 * A parsed freshness directive:
 *
 *   <!-- fresh: verified=2026-07-01 watch=package.json,src/auth/** owner=platform -->
 *
 * "A human verified this section's claims on <verified>; flag it if any
 * watched path has commits after that date."
 */
export interface FreshDirective {
  /** Repo-relative posix path of the doc containing the directive. */
  file: string;
  /** 1-based line of the directive comment. */
  line: number;
  /** Date (YYYY-MM-DD) or timestamp (YYYY-MM-DDTHH:MM[:SS]) of the last human verification. */
  verified: string;
  /** Paths / globs whose commits invalidate the verification. */
  watch: string[];
  owner?: string;
  /** Text of the nearest heading above the directive, or null. */
  section: string | null;
  /** Slug of the nearest heading above the directive, or null. */
  sectionSlug: string | null;
}

/** Date, optionally with a time: 2026-07-04 or 2026-07-04T14:30[:15]. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/;

function isValidDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Extract fresh directives from a parsed doc. Malformed directives are
 * dropped and reported as error findings.
 */
export function parseFreshDirectives(doc: DocFile): {
  directives: FreshDirective[];
  errors: Finding[];
} {
  const directives: FreshDirective[] = [];
  const errors: Finding[] = [];

  for (const comment of doc.comments) {
    const trimmed = comment.text.trim();
    if (!trimmed.startsWith('fresh:')) continue;

    const location = { file: doc.path, line: comment.line };

    const pairs = new Map<string, string>();
    for (const token of trimmed.slice('fresh:'.length).trim().split(/\s+/)) {
      const eq = token.indexOf('=');
      if (eq <= 0) continue;
      pairs.set(token.slice(0, eq), token.slice(eq + 1));
    }

    const verified = pairs.get('verified');
    if (verified === undefined || !isValidDate(verified)) {
      errors.push({
        check: 'freshness',
        severity: 'error',
        confidence: 'high',
        message:
          verified === undefined
            ? 'fresh directive is missing verified=YYYY-MM-DD'
            : `fresh directive has invalid verified date "${verified}" (expected YYYY-MM-DD or YYYY-MM-DDTHH:MM)`,
        location,
      });
      continue;
    }

    const watch = (pairs.get('watch') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (watch.length === 0) {
      errors.push({
        check: 'freshness',
        severity: 'error',
        confidence: 'high',
        message: 'fresh directive has an empty or missing watch list (expected watch=path,...)',
        location,
      });
      continue;
    }

    let section: string | null = null;
    let sectionSlug: string | null = null;
    for (const heading of doc.headings) {
      if (heading.line >= comment.line) break;
      section = heading.text;
      sectionSlug = heading.slug;
    }

    const directive: FreshDirective = {
      file: doc.path,
      line: comment.line,
      verified,
      watch,
      section,
      sectionSlug,
    };
    const owner = pairs.get('owner');
    if (owner !== undefined && owner.length > 0) directive.owner = owner;
    directives.push(directive);
  }

  return { directives, errors };
}
