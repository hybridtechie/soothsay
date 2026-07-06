import { posix } from 'node:path';
import type { Check, DocFile, Finding, RepoFacts } from '../types.js';
import { candidatePathFrom } from './pathExists.js';
import { filterIgnored } from '../repo/ignored.js';

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Interpreters/runners whose arguments in code blocks may be resource paths. */
const COMMANDS = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node', 'npx', 'source']);

interface Candidate {
  path: string;
  line: number;
}

/**
 * Path-like references in a SKILL.md: inline code, internal links, and
 * arguments after interpreter commands inside fenced code blocks.
 * Deduped by candidate path (first occurrence wins).
 */
function collectCandidates(doc: DocFile): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string, line: number): void => {
    const p = candidatePathFrom(raw);
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, line });
    }
  };

  for (const ic of doc.inlineCodes) add(ic.code, ic.line);

  for (const link of doc.links) {
    if (SCHEME_RE.test(link.href) || link.href.startsWith('#')) continue;
    const hashIdx = link.href.indexOf('#');
    add(hashIdx >= 0 ? link.href.slice(0, hashIdx) : link.href, link.line);
  }

  for (const block of doc.codeBlocks) {
    const blockLines = block.code.split('\n');
    for (let i = 0; i < blockLines.length; i++) {
      const tokens = blockLines[i]!.trim().split(/\s+/);
      if (tokens.length < 2 || !COMMANDS.has(tokens[0]!)) continue;
      // Only the first non-flag argument is the resource being run; later
      // tokens are outputs/arguments (`python a.py b.md --out c.md`).
      for (let j = 1; j < tokens.length; j++) {
        if (tokens[j]!.startsWith('-')) continue;
        // Content line i sits at startLine (fence) + 1 + i.
        add(tokens[j]!, block.startLine + 1 + i);
        break;
      }
    }
  }
  return out;
}

/** File or directory (trailing slash tolerated). */
function existsAt(repo: RepoFacts, p: string): boolean {
  const bare = p.replace(/\/+$/, '');
  return repo.files.has(bare) || repo.dirs.has(bare);
}

export const skillResources: Check = {
  name: 'skill-resource-exists',
  run(ctx) {
    const { repo } = ctx;
    const findings: Finding[] = [];

    // Missing-resource findings are deferred so gitignored candidates can be
    // dropped in one batched filterIgnored call per run.
    const pending: { finding: Finding; keys: string[] }[] = [];

    for (const doc of ctx.docs) {
      if (doc.path !== 'SKILL.md' && !doc.path.endsWith('/SKILL.md')) continue;
      const skillDir = posix.dirname(doc.path);

      for (const cand of collectCandidates(doc)) {
        const target = cand.path.replace(/\/+$/, '');
        if (target.length === 0) continue;
        const inSkillDir = posix.normalize(posix.join(skillDir, target));
        if (existsAt(repo, inSkillDir)) continue;

        const location = { file: doc.path, line: cand.line };
        if (existsAt(repo, target)) {
          // Repos may intentionally keep shared scripts/dirs at the root —
          // note it, but only as info/low.
          const rel = posix.relative(skillDir, target);
          findings.push({
            check: 'skill-resource-exists',
            severity: 'info',
            confidence: 'low',
            message: `\`${cand.path}\` is not in the skill directory but exists at the repo root`,
            location,
            suggestion: `From this skill directory, reference it as \`${rel}\` (or make clear the path is repo-root-relative).`,
          });
        } else {
          // A bare single-segment directory like `tasks/` or `unpacked/` is
          // usually an output-dir convention created at runtime, not a
          // committed resource — note it quietly instead of failing.
          const outputDirConvention = cand.path.endsWith('/') && !target.includes('/');
          pending.push({
            finding: {
              check: 'skill-resource-exists',
              severity: outputDirConvention ? 'info' : 'error',
              confidence: outputDirConvention ? 'low' : 'high',
              message: outputDirConvention
                ? `SKILL.md references \`${cand.path}\` which does not exist (may be created at runtime)`
                : `SKILL.md references \`${cand.path}\` but it does not exist`,
              location,
            },
            keys: [target, inSkillDir],
          });
        }
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
