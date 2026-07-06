## What

<!-- What does this PR change, and why? Link the issue if one exists. -->

## How to verify

<!-- Commands or steps a reviewer can run to see the change working. -->

## Checklist

- [ ] **Test added first** — this repo is TDD from commit one; the diff includes a test that fails without the change
- [ ] `npx vitest run` is green
- [ ] `npm run typecheck` is clean
- [ ] `CHANGELOG.md` updated under *Unreleased* (user-visible changes)
- [ ] New check? Registered in `src/checks/index.ts` **and** added to `EXPLANATIONS` in `src/cli.ts`
- [ ] Conventional commit message (`feat|fix|docs|chore(scope): ...`)
