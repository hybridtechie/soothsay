#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { loadProject, runChecks, verdict } from './engine.js';
import { allChecks } from './checks/index.js';
import { runAiAdvisor } from './ai/advisor.js';
import { bless } from './freshness/bless.js';
import { applyFixes } from './fix.js';
import { buildInitConfig } from './init.js';
import { renderGithub, renderJson, renderTty } from './report/render.js';

const HELP = `soothsay — your agent docs make claims. soothsay proves them.

Usage:
  soothsay check [path]     Verify agent docs against the repo (default command)
    --json                  Machine-readable output
    --github                GitHub Actions annotations
    --strict                Fail on warnings too
    --fix                   Apply safe autofixes (path casing, package-manager
                            rewrites), then re-check
    --ai                    Add the opt-in AI advisory pass (needs ANTHROPIC_API_KEY)
    --ai-budget <tokens>    Input-token ceiling for --ai (default 150000)
    --ai-model <model>      Model for --ai (default claude-haiku-4-5)
  soothsay bless <file> [--section <slug>] [--date YYYY-MM-DD]
                            Mark fresh: directives in <file> as re-verified today
  soothsay init [path]      Scan the repo, detect its sources of truth, and
                            scaffold a soothsay.yml with verified asserts
  soothsay explain <check>  Explain what a check does and how to fix findings

Docs: https://github.com/hybridtechie/soothsay`;

const EXPLANATIONS: Record<string, string> = {
  'path-exists':
    'A file path mentioned in a doc does not exist in the repo (or differs by case). Fix the doc, restore the file, or rename to the exact case.',
  'link-valid':
    'A markdown link points at a missing file or a heading anchor that does not exist. Update the link target or the heading.',
  'skill-resource-exists':
    'A SKILL.md references a script/resource that is missing from the skill directory. Skills silently fail when their resources are gone.',
  'command-exists':
    'A documented command refers to a package.json script or script file that does not exist. Update the doc or add the script.',
  'package-manager':
    'A doc instructs a different package manager than the repo declares (packageManager field / lockfile). Mixed instructions corrupt lockfiles.',
  'frontmatter-valid':
    'A SKILL.md or agent file is missing required frontmatter (name, description) or has a malformed tools list.',
  'tool-claim-mismatch':
    'An agent file claims to be read-only in prose but its frontmatter grants write-capable tools. The prose lies; agents get the tools.',
  freshness:
    'A section marked <!-- fresh: verified=DATE watch=paths --> has watched paths with commits after the verified date. Re-verify the section, then run: soothsay bless <file>.',
  asserts:
    'A sidecar assertion in soothsay.yml failed — a forbidden command appears in docs, a required file is missing, or a source-of-truth value diverged.',
  'assert-anchor':
    'An assertion anchors to a doc heading that no longer exists. This is how sidecar drift is caught — re-point the assert or restore the heading.',
  'assert-conflicts':
    'Two assertions contradict each other (forbid vs require with overlapping scope, or competing sources of truth). Narrow a scope or add an exception.',
  'ai-advisory':
    'Advisory-only output from the opt-in AI pass (--ai): prose contradictions, vague instructions, untyped claims. Never fails CI.',
};

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      github: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      fix: { type: 'boolean', default: false },
      ai: { type: 'boolean', default: false },
      'ai-budget': { type: 'string' },
      'ai-model': { type: 'string' },
      section: { type: 'string' },
      date: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const [first, ...rest] = positionals;
  const command = ['check', 'bless', 'init', 'explain'].includes(first ?? 'check')
    ? (first ?? 'check')
    : 'check';
  const args = command === first ? rest : positionals;

  switch (command) {
    case 'explain': {
      const id = args[0];
      if (!id || !EXPLANATIONS[id]) {
        console.log(`Known checks:\n${Object.keys(EXPLANATIONS).map((k) => `  ${k}`).join('\n')}`);
        return id ? 1 : 0;
      }
      console.log(`${id}\n\n${EXPLANATIONS[id]}`);
      return 0;
    }

    case 'init': {
      const root = resolve(args[0] ?? '.');
      const target = `${root}/soothsay.yml`;
      if (existsSync(target)) {
        console.error(`soothsay.yml already exists at ${root} — not overwriting.`);
        return 1;
      }
      const { yamlText, summary } = await buildInitConfig(root);
      writeFileSync(target, yamlText);
      for (const line of summary) console.log(line);
      console.log(`Created ${target}. Run \`soothsay check\` — Layer 0 works with zero config.`);
      return 0;
    }

    case 'bless': {
      const file = args[0];
      if (!file) {
        console.error('Usage: soothsay bless <file> [--section <slug>] [--date YYYY-MM-DD]');
        return 1;
      }
      const opts: { date?: string; section?: string } = {};
      if (values.date) opts.date = values.date;
      if (values.section) opts.section = values.section;
      const { updated } = bless(resolve('.'), file, opts);
      console.log(
        updated > 0
          ? `Blessed ${updated} fresh directive(s) in ${file}.`
          : `No fresh directives ${values.section ? `for section "${values.section}" ` : ''}found in ${file}.`,
      );
      // A file without directives is not an error — reserve non-zero for failures.
      return 0;
    }

    case 'check':
    default: {
      const root = resolve(args[0] ?? '.');
      let ctx = await loadProject(root);
      let findings = await runChecks(ctx, allChecks());
      let fixed = 0;

      if (values.fix) {
        const result = applyFixes(root, findings);
        fixed = result.applied.length;
        // Re-check from disk so the report reflects what actually remains.
        if (fixed > 0) {
          ctx = await loadProject(root);
          findings = await runChecks(ctx, allChecks());
        }
      }

      if (values.ai) {
        const budget = values['ai-budget'] ? Number(values['ai-budget']) : undefined;
        const ai = await runAiAdvisor(ctx, {
          apiKey: process.env.ANTHROPIC_API_KEY,
          ...(values['ai-model'] ? { model: values['ai-model'] } : {}),
          ...(budget ? { budgetTokens: budget } : {}),
        });
        findings.push(...ai.findings);
      }

      const v = verdict(findings, values.strict);
      if (values.json) console.log(renderJson(findings, v, values.fix ? fixed : undefined));
      else if (values.github) console.log(renderGithub(findings));
      else console.log(renderTty(findings, v, values.fix ? fixed : undefined));
      return v.failed ? 1 : 0;
    }
  }
}

// Set exitCode rather than calling process.exit(), which truncates
// stdout buffers over 64KB before they flush.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`soothsay: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
