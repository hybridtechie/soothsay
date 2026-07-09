import { posix } from 'node:path';
import type { Check, DocFile, Finding, RepoFacts } from '../types.js';
import { candidatePathFrom, topDirsOf } from './pathExists.js';
import { filterIgnored } from '../repo/ignored.js';
import { parseCd, nextCwd } from './cwd.js';

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Interpreters/runners whose arguments in code blocks may be resource paths. */
const COMMANDS = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node', 'npx', 'source']);

interface Candidate {
  path: string;
  line: number;
  /**
   * Virtual working directory (relative to the skill dir) set by a preceding
   * `cd`/`pushd` in the same code block. Absent for inline-code/link
   * candidates and for commands run at the block's base directory.
   */
  cwd?: string;
}

/**
 * Path-like references in a SKILL.md: inline code, internal links, and
 * arguments after interpreter commands inside fenced code blocks.
 * Deduped by candidate path (first occurrence wins).
 */
function collectCandidates(doc: DocFile, topDirs: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string, line: number, cwd?: string): void => {
    const p = candidatePathFrom(raw, topDirs);
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, line, ...(cwd ? { cwd } : {}) });
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
    // Virtual cwd for this block: '' = skill-dir base, null = untrackable.
    let cwd: string | null = '';
    for (let i = 0; i < blockLines.length; i++) {
      // Split chained segments so a leading `cd`/`pushd` before `&&` updates
      // the virtual cwd for the interpreter command that follows.
      for (const seg of blockLines[i]!.split(/&&|;/)) {
        const trimmed = seg.trim();
        if (trimmed.length === 0) continue;
        const cdArg = parseCd(trimmed);
        if (cdArg !== null) {
          cwd = nextCwd(cwd, cdArg);
          continue;
        }
        const tokens = trimmed.split(/\s+/);
        if (tokens.length < 2 || !COMMANDS.has(tokens[0]!)) continue;
        if (cwd === null) continue; // untrackable cwd — cannot verify
        // Only the first non-flag argument is the resource being run; later
        // tokens are outputs/arguments (`python a.py b.md --out c.md`).
        for (let j = 1; j < tokens.length; j++) {
          if (tokens[j]!.startsWith('-')) continue;
          // Content line i sits at startLine (fence) + 1 + i.
          add(tokens[j]!, block.startLine + 1 + i, cwd || undefined);
          break;
        }
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
    const topDirs = topDirsOf(repo);

    // Missing-resource findings are deferred so gitignored candidates can be
    // dropped in one batched filterIgnored call per run.
    const pending: { finding: Finding; keys: string[] }[] = [];

    for (const doc of ctx.docs) {
      if (doc.path !== 'SKILL.md' && !doc.path.endsWith('/SKILL.md')) continue;
      const skillDir = posix.dirname(doc.path);

      for (const cand of collectCandidates(doc, topDirs)) {
        const target = cand.path.replace(/\/+$/, '');
        if (target.length === 0) continue;
        const inSkillDir = posix.normalize(posix.join(skillDir, target));
        if (existsAt(repo, inSkillDir)) continue;
        // C3: also resolve under any virtual cwd from a preceding `cd` in the
        // same code block.
        const underCwd = cand.cwd
          ? posix.normalize(posix.join(skillDir, cand.cwd, target))
          : null;
        if (underCwd !== null && existsAt(repo, underCwd)) continue;

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
          // committed resource. So is a nested, extension-bearing path whose
          // top segment is not a real repo directory (`project-delivery/…`,
          // `.azure/…`) — an agent-generated scaffold path, not drift. Both are
          // noted quietly. A missing path whose top segment IS a real repo dir,
          // or a bare in-skill resource, stays a hard error (genuine drift).
          const outputDirConvention = cand.path.endsWith('/') && !target.includes('/');
          const runtimeArtifact =
            outputDirConvention || (target.includes('/') && !topDirs.has(target.split('/')[0]!));
          // C4: a reference like `.github/skills/x/api.py` is often a
          // deploy/install path — the source file exists elsewhere in the repo
          // before it is copied there. When the basename matches a real repo
          // file, downgrade rather than false-flag. Heuristic → info/low only.
          const base = posix.basename(target);
          const basenameMatches = [...repo.files].filter((f) => posix.basename(f) === base);
          const deployPath = !runtimeArtifact && basenameMatches.length > 0;
          const downgrade = runtimeArtifact || deployPath;
          const matchList = basenameMatches
            .slice(0, 2)
            .map((f) => `\`${f}\``)
            .join(', ');
          pending.push({
            finding: {
              check: 'skill-resource-exists',
              severity: downgrade ? 'info' : 'error',
              confidence: downgrade ? 'low' : 'high',
              message: runtimeArtifact
                ? `SKILL.md references \`${cand.path}\` which does not exist (may be created at runtime / not a committed resource)`
                : deployPath
                  ? `SKILL.md references \`${cand.path}\` which does not exist here — looks like a deployment/install path; a file named \`${base}\` exists at ${matchList}`
                  : `SKILL.md references \`${cand.path}\` but it does not exist`,
              location,
            },
            keys: underCwd !== null ? [target, inSkillDir, underCwd] : [target, inSkillDir],
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
