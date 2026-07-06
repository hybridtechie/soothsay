import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import type { Check, CheckContext, Finding } from '../types.js';
import { parseFreshDirectives, type FreshDirective } from './directive.js';

/** Runs git with the given args in cwd; returns stdout, throws on failure. */
export type GitRunner = (args: string[], cwd: string) => string;

export function realGitRunner(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Freshness check: for each `fresh:` directive, ask git whether any watched
 * path has commits after the verified date. Injectable GitRunner for tests.
 */
export function makeFreshnessCheck(git: GitRunner = realGitRunner): Check {
  return {
    name: 'freshness',
    run(ctx: CheckContext): Finding[] {
      const findings: Finding[] = [];

      // Phase 1: parse every doc first, so a git failure on an early
      // directive cannot swallow later docs' parse errors.
      const directives: FreshDirective[] = [];
      for (const doc of ctx.docs) {
        const parsed = parseFreshDirectives(doc);
        findings.push(...parsed.errors);
        directives.push(...parsed.directives);
      }

      // Phase 2: ask git about each directive's watched paths.
      let gitHasWorked = false;
      for (const directive of directives) {
        // A time-stamped verification is used exactly; a date-only one
        // covers the whole verification day.
        const since = directive.verified.includes('T')
          ? directive.verified
          : `${directive.verified}T23:59:59`;
        let out: string;
        try {
          out = git(
            ['log', `--since=${since}`, '--pretty=format:%h %s', '--', ...directive.watch],
            ctx.repo.root,
          );
        } catch {
          if (!gitHasWorked) {
            // Not a repo / git missing: skip freshness entirely, quietly.
            findings.push({
              check: 'freshness',
              severity: 'info',
              confidence: 'low',
              message:
                'git is unavailable (not a git repository or git not installed); ' +
                'freshness checks were skipped',
              location: { file: directive.file, line: directive.line },
            });
            break;
          }
          continue;
        }
        gitHasWorked = true;

        const commits = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        if (commits.length === 0) continue; // fresh

        const section = directive.section ?? posix.basename(directive.file);
        findings.push({
          check: 'freshness',
          severity: 'warning',
          confidence: 'high',
          message:
            `"${section}" was last verified ${directive.verified}, but ` +
            `${commits.length} commit(s) touched watched paths since (latest: ${commits[0]!})`,
          location: { file: directive.file, line: directive.line },
          suggestion: `Re-verify the section, then run: soothsay bless ${directive.file}`,
        });
      }

      return findings;
    },
  };
}
