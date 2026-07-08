---
description: Run soothsay on this project and triage the findings (fix drift vs configure ignores)
---

Run soothsay against this project's agent docs and triage the results.

## Steps

1. From the project root, run:

   ```bash
   npx --yes @njtp/soothsay check --json
   ```

   (If the project already has `@njtp/soothsay` as a devDependency, plain `npx soothsay check --json` avoids the network fetch.)

2. Parse the JSON output. It contains a `findings` array (each finding has `check`, `severity`, `confidence`, `message`, `location.file`, `location.line`, optional `suggestion`) and a verdict.

3. Summarize the results **grouped by file**, errors first, then warnings, then info. For each finding show the line number, check id, and message. Keep it compact — one line per finding. State the overall verdict (pass/fail) and the counts.

4. For each error or warning, decide with the user whether it is:

   - **Genuine drift** — the doc really is wrong (path renamed, script deleted, package manager changed, agent tools changed). Offer to fix the doc: edit the offending line so it matches reality. Use the finding's `suggestion` when present. If the truth is unclear (e.g. was the file deleted deliberately?), check git history before editing.
   - **A false positive** — the flagged text is not actually a claim (a hypothetical example, a template placeholder, a doc about another repo). Offer to configure soothsay.yml instead: add the file to `ignore`, add the check id to `disable`, or narrow the `docs` globs. If no soothsay.yml exists yet, `npx --yes @njtp/soothsay init` scaffolds one. Prefer the narrowest ignore that silences the false positive.

5. If a `freshness` warning appears, the section needs human re-verification — after the user confirms the section is accurate, run `npx --yes @njtp/soothsay bless <file>` (optionally `--section <slug>`) rather than editing the directive by hand.

## Rules

- **Never blindly edit vendored or third-party docs** (anything under node_modules, vendor, or docs copied from another project). For those, configure ignores instead.
- Do not delete claims just to silence findings — fix them or ignore them deliberately.
- If a finding's `confidence` is `low`, treat it as a hint, not a fact; verify before acting.
- Unknown check id? Run `npx --yes @njtp/soothsay explain <check-id>` for what it means and how to fix it.
