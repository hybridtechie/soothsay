/**
 * package-manager: docs must not tell agents to mutate dependencies with a
 * package manager other than the one the repo declares.
 */
import type { Check, Finding, PackageManager } from '../types.js';
import { extractCommands } from './commandExists.js';
import { isNegativeExample } from './negation.js';

const MUTATING: { pm: PackageManager; re: RegExp }[] = [
  { pm: 'npm', re: /^npm\s+(?:install|i|ci|add)(?:\s|$)/ },
  { pm: 'yarn', re: /^yarn\s+(?:add|install)(?:\s|$)/ },
  { pm: 'pnpm', re: /^pnpm\s+(?:add|install|i)(?:\s|$)/ },
  { pm: 'bun', re: /^bun\s+(?:install|add)(?:\s|$)/ },
];

const GLOBAL_FLAG_RE = /(?:^|\s)(?:-g|--global)(?:\s|$)/;

const PM_CMD_RE = /^(npm|pnpm|yarn|bun)\s+(install|i|ci|add)(?:\s+(.*))?$/;

/** The `npm ci` equivalent per manager. */
const FROZEN_INSTALL: Record<PackageManager, string> = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  bun: 'bun install --frozen-lockfile',
};

const DEV_FLAGS = new Set(['-D', '--save-dev', '--dev']);

/**
 * Translate a dependency-mutating command to the declared package manager,
 * preserving intent (plain install vs frozen install vs adding packages).
 * Returns null when a faithful translation isn't certain — unknown flags,
 * flag-only invocations — so `--fix` only ever applies known-safe rewrites.
 */
export function rewritePmCommand(cmd: string, declared: PackageManager): string | null {
  const m = PM_CMD_RE.exec(cmd.trim());
  if (!m) return null;
  const sub = m[2]!;
  const rest = (m[3] ?? '').trim();

  if (sub === 'ci') return rest === '' ? FROZEN_INSTALL[declared] : null;
  if (rest === '') return sub === 'add' ? null : `${declared} install`;

  // Arguments present: adding packages. Only the dev flag translates safely.
  const pkgs: string[] = [];
  let dev = false;
  for (const token of rest.split(/\s+/)) {
    if (DEV_FLAGS.has(token)) {
      dev = true;
      continue;
    }
    if (token.startsWith('-')) return null;
    pkgs.push(token);
  }
  if (pkgs.length === 0) return null;
  const verb = declared === 'npm' ? 'install' : 'add';
  const devFlag = dev ? (declared === 'bun' ? ' --dev' : ' -D') : '';
  return `${declared} ${verb} ${pkgs.join(' ')}${devFlag}`;
}

export const packageManagerConsistent: Check = {
  name: 'package-manager',
  run(ctx) {
    const findings: Finding[] = [];
    const declared = ctx.repo.packageManager;
    if (declared === null) return findings;
    const source = ctx.repo.packageManagerSource ?? 'lockfile';

    for (const doc of ctx.docs) {
      for (const { cmd, line, fromFence } of extractCommands(doc)) {
        const match = MUTATING.find((m) => m.re.test(cmd));
        if (!match || match.pm === declared) continue;

        const isGlobal = GLOBAL_FLAG_RE.test(cmd);
        const negative = isNegativeExample(doc, line, cmd);
        const location = { file: doc.path, line };
        // Rewrites apply only to unambiguous violations — global installs
        // and negative examples may be intentional.
        const rewritten = negative || isGlobal ? null : rewritePmCommand(cmd, declared);
        findings.push({
          check: 'package-manager',
          severity: negative ? 'info' : isGlobal ? 'warning' : 'error',
          confidence: negative || isGlobal ? 'low' : fromFence ? 'high' : 'medium',
          message:
            `\`${cmd}\` found in ${doc.path} but this repo uses ${declared} (declared in ${source})` +
            (negative ? ' (appears in a negative example)' : ''),
          location,
          suggestion: `Use \`${rewritten ?? cmd.replace(/^\S+/, declared)}\` instead`,
          ...(rewritten ? { fix: { ...location, from: cmd, to: rewritten } } : {}),
        });
      }
    }

    return findings;
  },
};
