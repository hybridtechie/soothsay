# Vision

## The problem

AI-assisted projects accumulate markdown that *controls agent behaviour*: `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, subagent definitions, cursor rules, architecture docs. These files are load-bearing — every agent session reads them and acts on them — yet they are treated as prose. Nothing fails when they drift:

- The doc says `npm install`; the repo moved to pnpm months ago.
- A skill references `FORMS.md`; the file was renamed `forms.md`.
- An agent is described as *read-only*; its frontmatter grants `Edit` and `Bash`.
- "Always run tests before committing" — which command? It was deleted in March.
- Two instruction files quietly contradict each other, and every agent flips a coin.

Code has compilers, linters, tests, and CI. Agent markdown has nothing. **Docs drift because prose is semantically invisible — and the breakage happens when *code* changes, not when docs are edited.** That's why the fix belongs in CI, on every code change.

## The insight: extraction over annotation

The obvious design — invent a typed grammar, ask humans to annotate every instruction with metadata blocks — fails twice. The annotations restate the prose, so they drift from it exactly the way docs drift from code (nothing binds "use pnpm" to `do: use_pnpm()`). And annotation-required tools deliver zero value until a repo is hand-annotated, so nobody adopts them. Inline metadata in `CLAUDE.md` also costs real money: agents load these files raw, so every hidden block is tokens billed on *every session, forever*.

Soothsay inverts this:

> **Never ask a human to restate a fact the repo already states.**
> Extract claims from the docs that exist today; verify them against the repo. Annotate only what extraction cannot infer — minimally, and never inside the agent's context window.

## The four layers

1. **Layer 0 — Extract & verify (zero config).** Commands, paths, links, lockfile/package-manager consistency, skill resources, frontmatter, tool-permission-vs-prose claims — all pulled from existing markdown and checked against repo facts. Value on the first `npx @njtp/soothsay check`, on any repo, with no setup. This is the adoption wedge.

2. **Layer 1 — Freshness (one-line directives).** The single fact extraction can't infer is which code paths invalidate which doc sections. `<!-- fresh: verified=DATE watch=globs -->` plus `git log` answers it deterministically. `soothsay bless` re-stamps after human review.

3. **Layer 2 — Sidecar assertions (closed vocabulary).** Claims that need stating live in `soothsay.yml` — *outside* agent context, zero token tax. Each assert **anchors to a heading** in the prose it enforces; a dead anchor is an error, so the sidecar cannot silently drift. The vocabulary is closed (~6 deterministic assert types), which is what makes conflict detection *tractable*: per-type detectors over known semantics, not a general engine over free-form English.

4. **Layer 3 — AI advisory (opt-in, never blocking).** Cross-file prose contradictions and vagueness are judgment calls only a model can make — so they are warnings, never CI failures. Budgeted, content-hash cached, Haiku-priced. The deterministic core costs $0 forever; the AI pass costs cents, only when asked.

## Design principles

- **Deterministic core.** A CI tool that hallucinates is dead on arrival. Every blocking finding is mechanically verifiable.
- **Confidence tiers.** Only high-confidence errors fail the build by default. False positives are the death of lint tools; when unsure, soothsay says so quietly.
- **Zero token tax.** Nothing soothsay asks you to write gets loaded into agent context except one-line freshness markers you opt into.
- **CI first, editor later.** Docs break when code changes — the check belongs next to the tests. (Structural authoring-time linting is agnix's turf; we don't rebuild it.)
- **Sidecar over inline, anchors over duplication, closed vocabulary over DSL.**

## What soothsay is not

- Not a markdown formatter or style linter (markdownlint exists).
- Not a frontmatter/structure linter for agent configs (agnix, cclint exist — 400+ rules, an LSP; use them, they're good).
- Not a general "compile English" engine. Prose doesn't compile. Claims can be proven.

## Roadmap

- [x] Layer 0: zero-config extraction checks
- [x] Layer 1: freshness + `bless`
- [x] Layer 2: sidecar asserts + anchor validation + conflict detectors
- [x] Layer 3: opt-in AI advisory (budgeted, cached)
- [x] `--github` annotations + GitHub Action
- [x] `init` that auto-detects sources of truth and proposes asserts
- [ ] SARIF output
- [x] `--fix` for safe autofixes (path case, package-manager rewrites)
- [ ] VS Code extension (thin wrapper over `check --json`)
- [ ] Watch-mode for doc authors

*Existing tools lint agent markdown. Soothsay proves it.*
