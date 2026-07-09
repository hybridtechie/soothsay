# soothsay — guide for Claude Code

Soothsay verifies AI-agent instruction files against the actual state of the repo and fails CI when the docs lie. Soothsay lints **this file** in its own CI, so keep every path and command below real — that is the point of the tool.

Deeper detail lives in [CONTRIBUTING.md](CONTRIBUTING.md) (architecture, conventions) and [VISION.md](VISION.md) (design rationale).

## Commands

```bash
npm install
npm test            # vitest, full suite — run before every commit
npm run typecheck   # tsc --noEmit
npm run build       # emits dist/
```

`npm run test:watch` runs vitest in watch mode while you work.

## The rule: test-first, always

Every change lands **test-first**: write the failing test in `test/`, watch it fail, then implement. A diff that touches `src/` with no matching `test/` change is incomplete. For a bug fix, add the regression test that reproduces it first.

## Architecture

Pipeline: **parser → repo facts → checks → reporters**, with four verification layers riding on it.

- `src/parser/markdown.ts` — parses each doc into the `DocFile` IR (frontmatter, headings, code blocks, inline code, links, comments).
- `src/repo/scanner.ts`, `src/repo/ignored.ts` — repo facts and gitignore handling.
- `src/checks/` — Layer 0 zero-config checks. `src/freshness/` — Layer 1 (directives + `bless`). `src/asserts/` — Layer 2 (sidecar assertions + conflicts). `src/ai/advisor.ts` — Layer 3 (opt-in AI pass, never blocks CI).
- `src/report/render.ts` — TTY / JSON / GitHub output; the pass/fail verdict lives in `src/engine.ts`.
- Shared types in `src/types.ts`; the CLI in `src/cli.ts`; the programmatic API in `src/index.ts`.

To add a check: write the test, implement the `Check` interface under `src/checks/`, register it in `src/checks/index.ts`, and add an `EXPLANATIONS` entry in `src/cli.ts`. Only **high-confidence errors** fail CI by default — use `warning`/`medium` or `info`/`low` for heuristics that can misfire.

## Releases

Automated: every push to `main` publishes via the [release workflow](.github/workflows/release.yml). The bump is **patch by default** — put `#minor` (new features) or `#major` (breaking changes) in the commit message to override. Publishing uses npm OIDC trusted publishing (no token) with automatic provenance. Update `CHANGELOG.md` before merging.
