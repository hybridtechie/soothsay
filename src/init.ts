/**
 * `soothsay init`: scan the repo, detect its sources of truth, and scaffold
 * a soothsay.yml whose asserts are *derived from the repo* rather than typed
 * by hand — the roadmap's "init that auto-detects sources of truth and
 * proposes asserts".
 *
 * Two invariants keep the proposals honest:
 *   1. Never propose a fact the repo doesn't state (extraction over
 *      annotation, per VISION.md).
 *   2. Never scaffold a failing config: every proposal is verified against
 *      the current repo+docs before it is written, and anything that would
 *      fire on day one is dropped. `init` pins today's truth; drift from it
 *      fails later, which is the point.
 */

import YAML from 'yaml';
import { loadProject, runChecks, verdict } from './engine.js';
import { allChecks } from './checks/index.js';
import { assertsCheck, findCommandLines } from './asserts/run.js';
import { assertConflicts } from './asserts/conflicts.js';
import type {
  AssertRule,
  CheckContext,
  DocFile,
  PackageManager,
} from './types.js';

export interface InitProposal {
  rule: AssertRule;
  /** One-line rationale, written as a comment above the rule. */
  reason: string;
}

export interface InitResult {
  /** Full soothsay.yml contents to write. */
  yamlText: string;
  /** Proposals that survived verification, in file order. */
  proposals: InitProposal[];
  /** Human summary lines for the CLI to print. */
  summary: string[];
}

/** Mutating commands per manager, used to forbid the *other* managers. */
const PM_MUTATING_CMDS: Record<PackageManager, string[]> = {
  npm: ['npm install', 'npm ci', 'npm i'],
  pnpm: ['pnpm install', 'pnpm add'],
  yarn: ['yarn install', 'yarn add'],
  bun: ['bun install', 'bun add'],
};

/** Scripts worth requiring the docs to keep instructing. */
const WORKFLOW_SCRIPTS = ['test', 'build', 'lint', 'typecheck'];

const PM_HEADING_RE = /package|install|setup|environment|depend|tooling/i;

/** Slug-safe id fragment from a file path stem. */
function idFrom(path: string): string {
  const stem = path.split('/').pop()!.replace(/\.[^.]*$/, '');
  return stem.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function commandInDocs(docs: DocFile[], cmd: string): boolean {
  return docs.some((d) => findCommandLines(d, cmd).length > 0);
}

/**
 * A heading in CLAUDE.md/AGENTS.md that plausibly governs package
 * management — used to anchor the package-manager assert into the prose.
 * Anchoring elsewhere would be noise, so anything less confident anchors
 * nothing (doc: is optional).
 */
function findPmAnchor(docs: DocFile[]): string | null {
  for (const path of ['CLAUDE.md', 'AGENTS.md']) {
    const doc = docs.find((d) => d.path === path);
    const heading = doc?.headings.find((h) => PM_HEADING_RE.test(h.text));
    if (doc && heading) return `${doc.path}#${heading.slug}`;
  }
  return null;
}

/** Frontmatter `tools`, normalized to a string list (mirrors toolClaims). */
function frontmatterTools(doc: DocFile): string[] {
  const raw = doc.frontmatter?.['tools'];
  if (typeof raw === 'string') {
    return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  }
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

function detectProposals(ctx: CheckContext): InitProposal[] {
  const proposals: InitProposal[] = [];
  const { repo, docs } = ctx;

  // --- package manager: pin the declared value, forbid the others ---------
  if (repo.packageManager) {
    const pm = repo.packageManager;
    const hasField = typeof repo.packageJson?.['packageManager'] === 'string';
    const anchor = findPmAnchor(docs);

    if (hasField) {
      proposals.push({
        rule: {
          id: 'package-manager-pinned',
          ...(anchor ? { doc: anchor } : {}),
          source: 'package.json#packageManager',
          expect: pm,
        },
        reason: `package.json#packageManager declares ${pm} — fail if it silently changes`,
      });
    }

    // Only forbid commands the docs don't currently use, so the scaffolded
    // config passes today (current violations are already the built-in
    // package-manager check's job).
    const foreign = (Object.keys(PM_MUTATING_CMDS) as PackageManager[])
      .filter((other) => other !== pm)
      .flatMap((other) => PM_MUTATING_CMDS[other])
      .filter((cmd) => !commandInDocs(docs, cmd));
    if (foreign.length > 0) {
      proposals.push({
        rule: {
          id: 'no-foreign-package-managers',
          ...(anchor ? { doc: anchor } : {}),
          forbid_command: foreign,
          ...(hasField ? { source: 'package.json#packageManager' } : {}),
        },
        reason: `this repo uses ${pm} (${repo.packageManagerSource ?? 'lockfile'}) — keep other managers out of the docs`,
      });
    }
  }

  // --- agent tool grants: pin what each agent may touch --------------------
  for (const doc of docs) {
    const tools = frontmatterTools(doc);
    if (tools.length === 0 || typeof doc.frontmatter?.['name'] !== 'string') continue;
    proposals.push({
      rule: {
        id: `pin-tools-${idFrom(doc.path)}`,
        agent: doc.path,
        allowed: tools,
      },
      reason: `snapshot of ${doc.path}'s tool grants — widening them must be deliberate`,
    });
  }

  // --- documented workflow commands: docs must keep instructing them -------
  const pm = repo.packageManager ?? 'npm';
  for (const script of WORKFLOW_SCRIPTS) {
    if (!repo.packageScripts.has(script)) continue;
    const forms = [
      `${pm} run ${script}`,
      ...(script === 'test' && pm !== 'bun' ? [`${pm} test`] : []),
      ...(pm === 'pnpm' || pm === 'yarn' ? [`${pm} ${script}`] : []),
    ];
    const found = forms.find((f) => commandInDocs(docs, f));
    if (!found) continue;
    proposals.push({
      rule: { id: `docs-instruct-${script}`, require_command: [found] },
      reason: `package.json has a "${script}" script and the docs instruct \`${found}\` — keep it documented`,
    });
  }

  return proposals;
}

/**
 * Run the real assert engine over the proposals and drop any rule that
 * produces a finding right now. Detection already aims for this, but the
 * engine is the arbiter — a scaffolded config must pass on day one.
 */
async function verifyProposals(
  ctx: CheckContext,
  proposals: InitProposal[],
): Promise<InitProposal[]> {
  let current = [...proposals];
  while (current.length > 0) {
    const testCtx: CheckContext = {
      ...ctx,
      config: { ...ctx.config, asserts: current.map((p) => p.rule) },
    };
    const findings = [
      ...(await assertsCheck.run(testCtx)),
      ...(await assertConflicts.run(testCtx)),
    ];
    if (findings.length === 0) return current;
    const next = current.filter(
      (p) => !findings.some((f) => f.message.includes(`"${p.rule.id}"`)),
    );
    // Findings we cannot attribute to a rule: propose nothing rather than
    // scaffold a config that fails.
    if (next.length === current.length) return [];
    current = next;
  }
  return current;
}

const HEADER = `# soothsay.yml — sidecar assertions for agent docs.
# Zero config is valid: soothsay's Layer 0 checks run without this file.
# Docs scanned by default: CLAUDE.md, AGENTS.md, README.md, .claude/**/*.md,
# .cursor/rules/**/*.md*, docs/**/*.md, **/SKILL.md

# Using \`soothsay check --ai\`? Add .soothsay-cache.json to your .gitignore.

# docs:            # override which docs are scanned
#   - CLAUDE.md
# ignore:          # extra ignore globs
#   - "archive/**"
# disable:         # check ids to turn off
#   - link-valid
`;

const EMPTY_ASSERTS = `
asserts: []
#  - id: package-manager
#    doc: CLAUDE.md#package-management   # anchor into prose; a dead anchor is an error
#    forbid_command: ["npm install", "yarn install"]
#    scope: "**/*.md"
#    source: package.json#packageManager
#    expect: pnpm
`;

function renderYaml(proposals: InitProposal[]): string {
  if (proposals.length === 0) return HEADER + EMPTY_ASSERTS;
  const rules = proposals
    .map((p) => {
      const body = YAML.stringify([p.rule])
        .trimEnd()
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n');
      return `  # ${p.reason}\n${body}`;
    })
    .join('\n');
  return `${HEADER}\n# Asserts below were detected from this repo's sources of truth by\n# \`soothsay init\` and verified to pass against the current state.\nasserts:\n${rules}\n`;
}

/** Detect, verify, and render — the CLI writes the result to soothsay.yml. */
export async function buildInitConfig(root: string): Promise<InitResult> {
  const ctx = await loadProject(root);
  const layer0 = await runChecks(ctx, allChecks());
  const v = verdict(layer0);

  const proposals = await verifyProposals(ctx, detectProposals(ctx));
  const yamlText = renderYaml(proposals);

  const summary = [
    `Scanned ${ctx.docs.length} doc(s) — current findings: ${v.errors} error(s), ${v.warnings} warning(s), ${v.infos} info.`,
    ...(proposals.length > 0
      ? [
          `Detected ${proposals.length} assert(s) from this repo's sources of truth (all pass today):`,
          ...proposals.map((p) => `  • ${p.rule.id} — ${p.reason}`),
        ]
      : ['No sources of truth detected to assert on — scaffolded a commented example instead.']),
  ];
  return { yamlText, proposals, summary };
}
