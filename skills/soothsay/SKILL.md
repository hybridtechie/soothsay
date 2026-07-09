---
name: soothsay
description: Verify agent instruction files against the actual repository. Use when the user says "check my agent docs", "is my CLAUDE.md stale", "verify agent instructions", "doc drift", or asks whether instruction files (CLAUDE.md, AGENTS.md, SKILL.md, subagent definitions) still match the codebase.
---

# Soothsay — prove what your agent docs claim

Soothsay extracts checkable claims from agent instruction files and verifies them against the repo. Use it whenever docs might have drifted from reality.

## Which command, when

| Situation | Command |
|---|---|
| Audit the project's agent docs | `npx --yes @njtp/soothsay check` (add `--json` when you need to parse results, `--strict` to fail on warnings) |
| CI or PR annotations | `npx --yes @njtp/soothsay check --github` |
| Findings are mechanical (wrong casing, wrong package manager) | `npx --yes @njtp/soothsay check --fix` — applies only provably-safe rewrites, then re-checks |
| A section was re-verified by a human and its freshness warning should clear | `npx --yes @njtp/soothsay bless <file>` (optionally `--section <slug>`) |
| The project needs a sidecar config (ignores, disabled checks, assertions) | `npx --yes @njtp/soothsay init` — detects the repo's sources of truth (package manager, agent tool grants, documented scripts) and scaffolds verified asserts; edit soothsay.yml to taste |
| A finding's check id is unclear | `npx --yes @njtp/soothsay explain <check-id>` |
| Reason about contradictions/vagueness yourself, without an API key | `npx --yes @njtp/soothsay advise --emit-task` — see "Layer 3" below |

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

## Layer 3 — you are the reviewer (no API key)

Layers 0–2 are deterministic. Layer 3 is a *judgement* pass — cross-file contradictions, vague instructions, checkable claims stated only in prose — that needs an LLM. When soothsay runs inside a coding agent, **you are that LLM**: no `ANTHROPIC_API_KEY`, no separate model call. Drive it like this:

1. Run the deterministic pass first: `npx --yes @njtp/soothsay check --json` and triage those findings.
2. Get the review task: `npx --yes @njtp/soothsay advise --emit-task`. It prints JSON with `system` (your instructions as the reviewer), `corpus` (every scanned doc, path-headed, with 1-based line numbers), and `schema` (the exact output shape).
3. **You** review the corpus against the `system` rubric — report only high-signal issues of three `kind`s: `contradiction`, `vague`, `untyped_claim`. Be conservative; silence beats noise. Cite the exact file path and line number from the corpus. Produce `{ "findings": [ { "kind", "file", "line", "message", "suggestion" }, ... ] }` matching the schema (empty `findings` is the right answer when nothing is wrong).
4. Optionally fold your findings back into a soothsay report for the user: write them to a file and run `npx --yes @njtp/soothsay advise --ingest <file>` (add `--json` to parse). Advisory findings are never CI-blocking — they are review suggestions, not gates.

Use `check --ai` instead only in headless CI where no agent is present (it calls the Anthropic API and needs `ANTHROPIC_API_KEY`). Inside an agent, prefer `advise --emit-task` — it is free and uses the model already reasoning about the repo.

## The freshness workflow

Freshness directives bind a doc section to the code that can invalidate it — a one-line HTML comment placed under a heading:

```markdown
## Authentication
<!-- fresh: verified=2026-07-08 watch=package.json,src/auth/** -->
```

Choose watch globs that cover the code the section describes. Then:

1. Soothsay warns when any watched path has commits after the verified date.
2. When that warning fires, **a human re-reads the section against the current code**. Fix anything stale.
3. Only after review, re-stamp:

```bash
npx --yes @njtp/soothsay bless <file>
npx --yes @njtp/soothsay bless <file> --section <slug>
```

Never bless without reviewing — blessing asserts "a human verified this today". Backdating with `--date` is for recording a review that already happened, not for silencing warnings.
