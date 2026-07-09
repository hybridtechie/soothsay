<h1 align="center">soothsay</h1>

<p align="center"><b>Your agent docs make claims. Soothsay proves them.</b></p>

<p align="center">
  <a href="https://github.com/hybridtechie/soothsay/actions/workflows/ci.yml"><img src="https://github.com/hybridtechie/soothsay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@njtp/soothsay"><img src="https://img.shields.io/npm/v/@njtp/soothsay.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20"></a>
</p>

<p align="center">
  <a href="https://hybridtechie.github.io/soothsay/"><img src="https://hybridtechie.github.io/soothsay/soothsay-onepager.svg" alt="soothsay one-pager — verify your agent docs against the actual state of your repository" width="620"></a>
</p>

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

## What soothsay catches — and how it fixes it

Every finding carries a **check id**, a **severity** (`✗ error` / `⚠ warning` / `info`), and a **confidence** tier. Only high-confidence errors fail CI by default (see [CI](#ci)). Run `soothsay explain <check-id>` for any finding to see what it means and how to resolve it.

| Check | What it flags | Highest severity | How it's fixed |
|---|---|---|---|
| `path-exists` | A file path in a doc that doesn't exist — including **case-only mismatches** (`Scripts/Sync.py` vs `scripts/sync.py`). Missing paths under a known top-level dir warn; unrecognized tokens are info-only. A namespaced identifier that merely contains a slash — an MCP tool id (`microsoft/azure-devops-mcp`), an ARM type (`Microsoft.Web/sites`), `Given/When/Then` — is **not** treated as a path unless it has a file extension, a `./`/`../` prefix, or a real top-level dir as its first segment. | ✗ error (case mismatch) | **`--fix` autofix** rewrites the casing. Genuinely-missing paths → manual (fix the doc or restore the file). |
| `link-valid` | Broken internal links, dead same-file and cross-file heading anchors, broken reference-style links, case-mismatched link targets. Template hrefs (`{ComponentName}`, `{imageUrl}`) are skipped; a `../`-relative sibling-asset link that resolves uniquely elsewhere (a flattened install layout) is downgraded to info. | ✗ error | **`--fix` autofix** for casing. Broken targets/anchors → manual, with a "did you mean" suggestion where one exists. |
| `skill-resource-exists` | A `SKILL.md` referencing a script/asset missing from its skill directory. Downgraded to info when the resource lives at the repo root instead, is a runtime-generated path (its top-level dir is absent from the repo), or is a deployment/install path whose basename exists elsewhere in the repo. | ✗ error | Manual — add the resource, or reference it by its real (repo-root-relative) path per the suggestion. |
| `command-exists` | `pnpm run build` with no `build` script; a bare `pnpm` subcommand that's neither a builtin nor a script (warns); a file passed to an interpreter (`scripts/x.py`) that doesn't exist. A preceding `cd`/`pushd` in the same shell block sets the directory used to resolve the file; commands under an untrackable `cd` (a variable, an absolute or home path) are not flagged. Inline commands are medium-confidence; fenced ones high. | ✗ error | **`--fix` autofix** for path casing. Missing scripts/files → manual (add the script or fix the path). |
| `package-manager` | A dependency-mutating command for the wrong manager — `npm install` in a pnpm repo. Global installs warn; negative examples ("never run `npm install`") drop to info. | ✗ error | **`--fix` autofix** translates intent-preserving cases (`npm ci → pnpm install --frozen-lockfile`, `npm i -D vitest → pnpm add vitest -D`). Ambiguous cases → manual. |
| `frontmatter-valid` | A `SKILL.md` / agent file missing required `name` or `description`, a malformed `name`, an over-long `description` (>1024), or a `tools` key that isn't a string/string-array. Frontmatter that is **present but fails to parse** (e.g. an unquoted `description:` value containing `': '`) is reported distinctly from missing frontmatter, with a quoting suggestion. | ✗ error | Manual — add or correct the frontmatter field. |
| `tool-claim-mismatch` | An agent whose prose says it's **read-only** while its frontmatter grants `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` — or declares no `tools` restriction at all (inherits everything). | ✗ error | Manual — remove the write tool, or drop the read-only claim (the suggestion says which). |
| `freshness` | A `fresh:` directive (see [Layer 1](#layer-1--freshness-tracking)) whose watched paths have commits after its verified date — the section is stale. Malformed directives are errors. | ⚠ warning | Re-verify, then **`soothsay bless <file>`** re-stamps the directive. |
| `asserts` | A sidecar rule in `soothsay.yml` that failed — a forbidden command in docs, a missing required file/command, a forbidden import, or a source-of-truth value that diverged. | ✗ error | Manual — fix the doc/code the assert protects, or adjust the assert. |
| `assert-anchor` | An assert anchored (`doc:`) to a heading or file that no longer exists — how sidecar drift is caught. | ✗ error | Manual — re-point the assert or restore the heading (near-miss slugs are suggested). |
| `assert-conflicts` | Two asserts that can never both hold: duplicate ids, forbid-vs-require of the same command in overlapping scope, or competing sources of truth. | ✗ error | Manual — narrow a scope, add an `except`, or remove the duplicate. |
| `ai-advisory` (opt-in `--ai`) | Prose contradictions across docs, vague instructions, and untyped claims worth pinning as asserts. | ⚠ warning | Advisory only — **never fails CI**; act on the suggestion at your discretion. |

**Three fix paths, by design:**

- **`soothsay check --fix`** applies only the rewrites soothsay is *certain* about — path/link casing and intent-preserving package-manager translations — then re-checks from disk. Everything ambiguous is left untouched and stays a finding. (See [Autofix](#autofix).)
- **`soothsay bless <file>`** resolves `freshness` findings by re-stamping the verified date after you've re-checked a section.
- **Everything else is manual**, but never blind: each finding names the exact `file:line` and, where a safe one exists, a `suggestion:` telling you what to change.

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

This adds a `/soothsay:check` slash command that runs `npx --yes @njtp/soothsay check --json` in your project root, summarizes errors and warnings grouped by file, and helps you triage each finding — fixing genuine doc drift, or configuring ignores in soothsay.yml for false positives (never blindly editing vendored docs). A bundled skill also teaches Claude the check ids, the fix-vs-ignore decision guide, and the freshness/bless workflow, so plain requests like "is my CLAUDE.md stale?" work too.

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
