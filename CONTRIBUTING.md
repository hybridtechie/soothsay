# Contributing to soothsay

Thanks for helping make agent docs honest. This guide covers setup, architecture, and the workflow every change follows.

## Dev setup

Requires Node >= 20 and npm.

```bash
npm install
npm test            # vitest, full suite
npm run typecheck   # tsc --noEmit
npm run build       # emits dist/
```

`npm run test:watch` runs vitest in watch mode while you work.

## Architecture map

Soothsay is a pipeline: **parser → repo facts → checks over a claim IR → reporters**. Four layers of verification ride on that pipeline.

| Stage | What it does | Where |
|---|---|---|
| **Parser** | Parses each scanned doc into a `DocFile` IR: frontmatter, headings (with GitHub-style slugs), fenced code blocks, inline code spans, links, HTML comments | `src/parser/markdown.ts` |
| **Repo facts** | Scans the repository once into `RepoFacts`: file/dir sets, case-insensitive path map, package.json scripts, lockfiles, declared package manager. Gitignore handling lives beside it | `src/repo/scanner.ts`, `src/repo/ignored.ts` |
| **Checks** | Each check consumes `CheckContext` (repo facts + parsed docs + config) and emits `Finding`s with severity + confidence | `src/checks/*.ts` (Layer 0), `src/freshness/` (Layer 1), `src/asserts/` (Layer 2), `src/ai/advisor.ts` (Layer 3, opt-in) |
| **Reporters** | Render findings as TTY output, JSON, or GitHub annotations; compute the pass/fail verdict | `src/report/render.ts`, verdict in `src/engine.ts` |

Shared types (the claim IR: `DocFile`, `RepoFacts`, `Finding`, `Check`, `AssertRule`) live in `src/types.ts`. The CLI (`src/cli.ts`) wires it all together; `src/config.ts` loads `soothsay.yml`; `src/index.ts` is the programmatic API surface.

The four verification layers (see [VISION.md](VISION.md) for the rationale):

1. **Layer 0** — zero-config extraction checks: `src/checks/` (path-exists, link-valid, skill-resource-exists, command-exists, package-manager, frontmatter-valid, tool-claim-mismatch).
2. **Layer 1** — freshness directives + `bless`: `src/freshness/` (`directive.ts`, `check.ts`, `bless.ts`).
3. **Layer 2** — sidecar assertions + conflict detection: `src/asserts/` (`run.ts`, `conflicts.ts`).
4. **Layer 3** — opt-in AI advisory: `src/ai/advisor.ts`. Never blocks CI.

## THE RULE: test-first, always

This repo was built TDD from commit one. **Every change lands test-first** — write the failing test in `test/`, watch it fail, then make it pass. PRs whose diff shows production code without a corresponding test change will be asked to add the test (and to show it fails without the fix).

- Tests live in `test/*.test.ts` (vitest), fixtures in `test/fixtures/`.
- Bug fix? First add a regression test that reproduces the bug.
- New behaviour? The test is the spec — write it before the implementation.

## Adding a new check

1. **Write the test first** in `test/` — feed a fixture doc + repo state, assert the exact findings (check id, severity, confidence, location).
2. Implement the `Check` interface (from `src/types.ts`) in a new file under `src/checks/`:
   ```ts
   export const myCheck: Check = {
     name: 'my-check',
     run(ctx) { /* return Finding[] */ },
   };
   ```
3. Register it in `allChecks()` in `src/checks/index.ts` (keep the layer ordering).
4. Add an entry to `EXPLANATIONS` in `src/cli.ts` so `soothsay explain my-check` works — one or two sentences: what the finding means and how to fix it.
5. Mind confidence tiers: only **high-confidence errors** fail builds by default. When a heuristic can misfire, emit `warning`/`medium` or `info`/`low` instead. False positives are the death of lint tools.

## Commit conventions

Conventional commits, with an optional scope:

```
feat(checks): add sarif output for command-exists
fix(parser): handle nested fenced blocks
docs: clarify bless workflow
chore(ci): bump node matrix
```

Types: `feat`, `fix`, `docs`, `chore` (also fine: `test`, `refactor`). Scope is the area touched: `checks`, `parser`, `repo`, `asserts`, `freshness`, `ai`, `cli`, `report`, `ci`.

## Semver policy

- **Major** — breaking CLI or config changes: removed/renamed commands or flags, changed `soothsay.yml` semantics, changed JSON output shape, changed exit-code behaviour.
- **Minor** — new checks and new features. **Note:** a new check can surface new error-severity findings, which can fail builds that passed before. That is by design (the tool exists to catch drift), but it is why new checks are a *minor* bump and are called out prominently in the changelog — pin your version in CI if you need byte-stable behaviour.
- **Patch** — bug fixes, false-positive reductions, docs.

## Release process (maintainers)

Releases are automated: **every push to `main` publishes.** The
[release workflow](.github/workflows/release.yml) decides the version bump, applies
it, publishes to npm, pushes the bump back to `main`, and cuts the GitHub release
with generated notes. There is no manual `npm version` or tagging.

1. Before merging, update `CHANGELOG.md`: move entries from *Unreleased* into a new
   version section dated today.
2. Choose the bump via the merge commit message — **patch by default**; include
   `#minor` for new features or `#major` for breaking changes (see the semver policy
   above). The workflow bumps `package.json` and commits `chore(release): x.y.z [skip ci]`.
3. Publishing uses **npm OIDC trusted publishing** — no `NPM_TOKEN` secret — and
   provenance attestations are attached automatically. This requires a Trusted
   Publisher configured on npmjs.com for this repo + `release.yml`; the release job
   runs on Node 24 (its bundled npm satisfies the OIDC minimum of `npm >= 11.5.1`).
