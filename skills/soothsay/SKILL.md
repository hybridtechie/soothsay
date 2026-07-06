---
name: soothsay
description: Verify agent instruction files against the actual repository. Use when the user says "check my agent docs", "is my CLAUDE.md stale", "verify agent instructions", "doc drift", or asks whether instruction files (CLAUDE.md, AGENTS.md, SKILL.md, subagent definitions) still match the codebase.
---

# Soothsay — prove what your agent docs claim

Soothsay extracts checkable claims from agent instruction files and verifies them against the repo. Use it whenever docs might have drifted from reality.

## Which command, when

| Situation | Command |
|---|---|
| Audit the project's agent docs | `npx --yes soothsay check` (add `--json` when you need to parse results, `--strict` to fail on warnings) |
| CI or PR annotations | `npx --yes soothsay check --github` |
| Findings are mechanical (wrong casing, wrong package manager) | `npx --yes soothsay check --fix` — applies only provably-safe rewrites, then re-checks |
| A section was re-verified by a human and its freshness warning should clear | `npx --yes soothsay bless <file>` (optionally `--section <slug>`) |
| The project needs a sidecar config (ignores, disabled checks, assertions) | `npx --yes soothsay init` — detects the repo's sources of truth (package manager, agent tool grants, documented scripts) and scaffolds verified asserts; edit soothsay.yml to taste |
| A finding's check id is unclear | `npx --yes soothsay explain <check-id>` |

Run from the project root. Exit code 1 means at least one high-confidence error (with `--strict`, warnings too).

## Interpreting check ids

- **path-exists** — a doc mentions a file path that is missing or has the wrong casing. Fix the doc or restore/rename the file.
- **link-valid** — a markdown link targets a missing file or a dead heading anchor. Update the link or the heading.
- **command-exists** — a documented command points at a nonexistent package.json script or script file. Update the doc or add the script.
- **package-manager** — the doc instructs a different package manager than the repo declares (packageManager field or lockfile). Rewrite the command for the declared manager.
- **frontmatter-valid** — a skill or agent file is missing required frontmatter (name, description) or has a malformed tools list.
- **tool-claim-mismatch** — an agent's prose says read-only but its frontmatter grants write-capable tools. Fix whichever side is wrong: the prose or the tools.
- **skill-resource-exists** — a skill file references a script or asset that is not in its skill directory. Restore the resource or fix the reference.
- **freshness** — commits touched watched paths after the section's verified date. Needs human re-verification, then bless (see below).
- **asserts** — a sidecar assertion in soothsay.yml failed (forbidden command present, required file missing, source-of-truth value diverged).
- **assert-anchor** — an assertion points at a doc heading that no longer exists. Re-point the assert or restore the heading.
- **assert-conflicts** — two assertions contradict each other. Narrow a scope or add an exception.
- **ai-advisory** — advisory-only output from the opt-in AI pass. Never blocks; treat as review suggestions.

## Fix vs ignore — the decision guide

For every error or warning, decide which of two things is true:

1. **The doc lies (genuine drift).** The repo changed and the doc did not. Fix the doc: correct the path, the command, the package manager, the tool list. Use the finding's suggestion when one is given, and `check --fix` for the mechanical subset (casing, package-manager rewrites) — it only applies rewrites that are provably safe. This is the common case — soothsay exists to catch exactly this.
2. **The doc is fine (false positive).** The flagged text is an example, a placeholder, or refers to another repo. Do not "fix" correct prose. Instead configure soothsay.yml: add an `ignore` glob for the file, add the check id to `disable`, or narrow the `docs` globs. Choose the narrowest option that silences the false positive.

Rules of thumb:

- Never blindly edit vendored or third-party docs — ignore them instead.
- Findings with `low` confidence are hints; verify before acting.
- If unsure whether a referenced file was deleted deliberately, check git history before editing the doc.

## The freshness workflow

Freshness directives bind a doc section to the code that can invalidate it:

1. Add a one-line HTML comment under a heading, for example: `<!-- fresh: verified=2026-07-04 watch=package.json,src/auth/** -->`. Choose watch globs that cover the code the section describes.
2. Soothsay warns when any watched path has commits after the verified date.
3. When that warning fires, **a human re-reads the section against the current code**. Fix anything stale.
4. Only after review, re-stamp:

```bash
npx --yes soothsay bless <file>
npx --yes soothsay bless <file> --section <slug>
```

Never bless without reviewing — blessing asserts "a human verified this today". Backdating with `--date` is for recording a review that already happened, not for silencing warnings.
