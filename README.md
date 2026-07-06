# soothsay

> Your agent docs make claims. **Soothsay proves them.**

[![CI](https://github.com/hybridtechie/soothsay/actions/workflows/ci.yml/badge.svg)](https://github.com/hybridtechie/soothsay/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/soothsay.svg)](https://www.npmjs.com/package/soothsay)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

*Sooth* (n., Old English): **truth**. A soothsayer is, literally, a truth-teller.

Soothsay verifies AI-agent instruction files — `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, subagent definitions, cursor rules, READMEs — against the **actual state of your repository**, and fails CI when the docs lie.

```
$ npx @njtp/soothsay check

soothsay check

CLAUDE.md
  ✗ L7  [package-manager] `npm install` found but this repo uses pnpm (declared in package.json#packageManager)
      → Use `pnpm install` instead
  ✗ L9  [command-exists] command references `scripts/deploy.sh` which does not exist
  ✗ L11 [link-valid] broken link: docs/missing.md does not exist
  ⚠ L5  [freshness] "Setup" was last verified 2026-01-01, but 3 commit(s) touched package.json since
      → Re-verify the section, then run: soothsay bless CLAUDE.md
.claude/agents/reviewer.md
  ✗ L1  [tool-claim-mismatch] agent claims to be read-only but has the Edit tool

4 error(s), 1 warning(s), 0 info — FAIL
```

## Why

Agent instruction files control agent behaviour, but nothing fails loudly when they drift. Code has compilers, tests, and CI; agent markdown is treated as prose. So it goes stale, contradicts itself, references deleted scripts, and quietly misleads every agent that loads it.

Structural linters (agnix, cclint) already validate frontmatter and formatting. Soothsay does the thing they don't: **it checks whether what your docs *say* is still *true*.**

Full design rationale in [VISION.md](VISION.md).

## Install

```bash
npm install --save-dev @njtp/soothsay    # or: pnpm add -D @njtp/soothsay
npx soothsay check                       # zero config required
```

Requires Node ≥ 20.

## The four layers

### Layer 0 — Zero-config verification (just run it)

No annotations needed. Soothsay parses your agent docs, extracts every checkable claim, and verifies it against the repo:

| Check | Catches |
|---|---|
| `path-exists` | File paths mentioned in docs that don't exist (including **case mismatches** — `FORMS.md` vs `forms.md`) |
| `link-valid` | Broken internal links and dead heading anchors |
| `command-exists` | `pnpm run build` when there's no `build` script; a doc telling agents to run `scripts/x.py` when the file is gone |
| `package-manager` | `npm install` in a repo whose lockfile/`packageManager` field says pnpm |
| `frontmatter-valid` | SKILL.md / agent files missing `name`/`description`, malformed `tools` |
| `tool-claim-mismatch` | Agents whose prose says *read-only* while frontmatter grants `Edit`/`Write`/`Bash` |
| `skill-resource-exists` | SKILL.md referencing scripts/assets that aren't in the skill directory |

### Layer 1 — Freshness tracking

The one thing extraction can't infer: *which code invalidates which doc section*. One HTML comment per section:

```markdown
## Authentication
<!-- fresh: verified=2026-07-04 watch=package.json,src/auth/** -->
```

Soothsay checks `git log` — any commit touching a watched path after the verified date flags the section as stale. After you re-verify:

```bash
soothsay bless CLAUDE.md                      # re-stamps every directive in the file
soothsay bless CLAUDE.md --section authentication
```

### Layer 2 — Sidecar assertions

For claims extraction can't parse, assertions live in `soothsay.yml` — a **sidecar**, so your CLAUDE.md pays **zero token tax** in agent context. Each assert anchors to the prose it enforces; a dead anchor is itself an error, which is how sidecar drift gets caught:

```yaml
asserts:
  - id: package-manager
    doc: CLAUDE.md#package-management        # must point at a real heading
    forbid_command: ["npm install", "yarn install"]
    scope: "**/*.md"
    source: package.json#packageManager
    expect: pnpm

  - id: no-direct-db
    doc: docs/architecture.md#data-access
    forbid_import: "@/repositories/**"
    in: "src/api/**"
    except: ["src/api/health/**"]

  - id: reviewer-is-readonly
    agent: .claude/agents/reviewer.md
    allowed: [Read, Grep, Glob]
```

Assertion types: `forbid_command`, `require_command`, `require_file`, `forbid_import`, `value_matches_source` (`source` + `expect`), `tools_subset` (`agent` + `allowed`). The vocabulary is deliberately **closed** — every assert is deterministic, and per-type conflict detectors catch contradictions (a command both forbidden and required in overlapping scopes, two asserts claiming the same source of truth with different values).

### Layer 3 — AI advisory pass (opt-in, never blocks CI)

```bash
ANTHROPIC_API_KEY=... soothsay check --ai [--ai-budget 150000] [--ai-model claude-haiku-4-5]
```

Finds what only a model can: cross-file prose contradictions, vague instructions, untyped claims worth turning into asserts. Cost-controlled by design: content-hash cached (unchanged docs are never re-billed), token-budgeted (refuses to run past the ceiling), Haiku-class model by default, and **findings are advisory only** — they never fail the build.

## CI

```yaml
# .github/workflows/soothsay.yml
- run: npx @njtp/soothsay check --github
```

`--github` emits GitHub annotations so findings appear inline on the PR diff. Exit code is 1 only for **high-confidence errors** (use `--strict` to fail on warnings too) — confidence tiering exists precisely so CI doesn't cry wolf.

## Autofix

```bash
soothsay check --fix
```

Applies the rewrites soothsay is *certain* about, then re-checks from disk: path and link casing (`FORMS.md → forms.md`) and package-manager command translations that preserve intent (`npm ci → pnpm install --frozen-lockfile`, `npm i -D vitest → pnpm add vitest -D`). Anything ambiguous — unknown flags, global installs, negative examples — is left alone and stays a finding. Plain `check` tells you how many findings are auto-fixable.

## All commands

```
soothsay check [path] [--json|--github] [--strict] [--fix] [--ai]
soothsay bless <file> [--section <slug>] [--date YYYY-MM-DD]
soothsay init [path]          # detect sources of truth, scaffold a verified soothsay.yml
soothsay explain <check-id>   # what a finding means and how to fix it
```

`init` doesn't hand you an empty template: it scans the repo, detects its sources of truth — the declared package manager, each agent's `tools:` grants, the workflow scripts your docs instruct — and proposes asserts that pin them. Every proposal is verified against the current repo before it is written, so the scaffolded config passes on day one and only fires when something drifts later.

Config (`soothsay.yml`, all optional): `docs` (globs to scan), `ignore`, `disable` (check ids), `asserts`.

## Use as a Claude Code plugin

The repo doubles as an installable Claude Code plugin. In Claude Code:

```
/plugin marketplace add hybridtechie/soothsay
/plugin install soothsay
```

This adds a `/soothsay:check` slash command that runs `npx --yes soothsay check --json` in your project root, summarizes errors and warnings grouped by file, and helps you triage each finding — fixing genuine doc drift, or configuring ignores in soothsay.yml for false positives (never blindly editing vendored docs). A bundled skill also teaches Claude the check ids, the fix-vs-ignore decision guide, and the freshness/bless workflow, so plain requests like "is my CLAUDE.md stale?" work too.

## Programmatic API

```ts
import { loadProject, runChecks, allChecks, verdict } from 'soothsay';

const ctx = await loadProject(process.cwd());
const findings = await runChecks(ctx, allChecks());
console.log(verdict(findings));
```

## Development

TDD from the first commit — every module landed tests-first.

```bash
npm install
npm test            # vitest
npm run typecheck
npm run build
```

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the architecture map, and the test-first rule. Release history lives in [CHANGELOG.md](CHANGELOG.md). Docs site: <https://hybridtechie.github.io/soothsay/>.

## License

[MIT](LICENSE)
