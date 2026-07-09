# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Note on new checks: adding a check is a **minor** release, but new checks can surface new error-severity findings and fail builds that previously passed. Pin your version in CI if you need stable behaviour across upgrades.

## [Unreleased]

### Fixed

False-positive reduction for "producer"/catalog repos — skill and agent catalogs whose docs describe paths that resolve in a consuming project, after a `cd`, or after install, which soothsay wrongly failed CI on:

- **`path-exists` / `skill-resource-exists`: a lone slash no longer makes a token a file path.** A slashed token is treated as a path only when it has a file extension, a `./`/`../` prefix, or a first segment that is a real top-level repo directory. MCP tool ids (`microsoft/azure-devops-mcp`), ARM resource types (`Microsoft.Web/sites`), BDD keywords (`Given/When/Then`), branch names, option markers, and JSON field paths are no longer reported.
- **`skill-resource-exists`: runtime and deployment paths are downgraded to info, not CI-failing errors.** A reference whose top-level directory is absent from the repo (a runtime-generated artifact) or whose basename exists elsewhere (a deployment/install path) is now info/low.
- **`link-valid`: template and sibling-asset links no longer error.** Template hrefs (`{ComponentName}`, `{imageUrl}`) are skipped; a `../`-relative sibling-asset link that resolves uniquely elsewhere (a flattened install layout) is downgraded to info.
- **`command-exists` / `skill-resource-exists`: working-directory tracking.** A `cd`/`pushd` earlier in a shell block sets the directory used to resolve interpreter arguments; commands run under an untrackable `cd` (a variable, an absolute or home path) are no longer flagged.
- **`frontmatter-valid`: parse errors are distinguished from missing frontmatter.** Frontmatter that is present but fails to parse (e.g. an unquoted `description:` value containing a `': '` sequence) now reports the parse error with a quoting suggestion, instead of the misleading "has no frontmatter".

## [0.1.1] - 2026-07-08

### Added

- **`soothsay init` auto-detection.** `init` now scans the repo and scaffolds soothsay.yml with asserts derived from detected sources of truth: pins `package.json#packageManager` (`value_matches_source`), forbids the other package managers' mutating commands (`forbid_command`, skipping any the docs currently use), snapshots each agent file's `tools:` grants (`tools_subset`), and requires documented workflow commands to stay documented (`require_command` for `test`/`build`/`lint`/`typecheck` scripts the docs instruct). Every proposal is verified against the current repo and docs before writing, so the scaffolded config always passes on day one. Falls back to the commented example when nothing is detectable.
- **`soothsay check --fix` — safe autofixes.** Findings now carry machine-applicable rewrites where the fix is provably correct: path/link/command case corrections (from `path-exists`, `link-valid`, `command-exists`) and package-manager command translations that preserve intent (`npm ci` → `pnpm install --frozen-lockfile`, `npm i -D x` → `pnpm add x -D`; unknown flags, global installs, and negative examples are never rewritten). `--fix` applies them and re-checks from disk; plain `check` reports how many findings are auto-fixable. JSON output gains a `summary.fixed` count when `--fix` is used, and findings expose an optional `fix` object.
- Programmatic API: `applyFixes`, `caseCorrectToken`, `buildInitConfig`.
- README: a "What soothsay catches — and how it fixes it" reference table covering every check id, its severity/confidence tier, and its fix path (`--fix` autofix, `bless`, or manual).

### Changed

- CI now publishes to npm via **OIDC trusted publishing** (Node 24, automatic provenance attestations), replacing the token-based publish.

## [0.1.0] - 2026-07-04

Initial release.

### Added

- **Layer 0 — zero-config verification.** Seven extraction checks that run on any repo with no setup:
  - `path-exists` — file paths mentioned in docs that don't exist, including case mismatches
  - `link-valid` — broken internal links and dead heading anchors
  - `command-exists` — documented commands referring to missing package.json scripts or script files
  - `package-manager` — docs instructing a different package manager than the repo declares
  - `frontmatter-valid` — SKILL.md / agent files missing `name`/`description` or with malformed `tools`
  - `tool-claim-mismatch` — agents claiming to be read-only in prose while frontmatter grants write-capable tools
  - `skill-resource-exists` — SKILL.md referencing scripts/assets missing from the skill directory
- **Layer 1 — freshness tracking.** `<!-- fresh: verified=DATE watch=globs -->` directives checked against `git log`; `soothsay bless` re-stamps directives after human review (whole file or `--section`).
- **Layer 2 — sidecar assertions.** Closed-vocabulary asserts in soothsay.yml (`forbid_command`, `require_command`, `require_file`, `forbid_import`, `value_matches_source`, `tools_subset`) with heading-anchor validation and per-type **conflict detection** (forbid-vs-require overlaps, competing sources of truth).
- **Layer 3 — opt-in AI advisory pass** (`--ai`): cross-file contradictions and vague instructions, content-hash cached, token-budgeted, advisory-only — never fails the build.
- **CLI**: `check`, `bless`, `init`, `explain` commands with `--json`, `--github` (GitHub annotations), and `--strict` output/verdict flags.
- **GitHub Action** (`action.yml`): composite action running `soothsay check --github` with `path` and `strict` inputs.
- Programmatic API: `loadProject`, `runChecks`, `allChecks`, `verdict`.

[Unreleased]: https://github.com/hybridtechie/soothsay/compare/v0.1.2...HEAD
[0.1.1]: https://github.com/hybridtechie/soothsay/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hybridtechie/soothsay/releases/tag/v0.1.0
