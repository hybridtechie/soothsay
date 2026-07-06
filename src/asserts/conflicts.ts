/**
 * Layer 2b: conflict detection over the sidecar rules themselves. Two rules
 * that contradict each other can never both hold, so the sidecar is flagged
 * before any doc is blamed.
 */

import type { AssertRule, Check, CheckContext, Finding } from '../types.js';
import { docsInScope, RULE_LOCATION } from './run.js';

/** Paths of the docs a rule's scope applies to. */
function scopePaths(rule: AssertRule, ctx: CheckContext): Set<string> {
  return new Set(docsInScope(ctx.docs, rule.scope).map((d) => d.path));
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const p of a) if (b.has(p)) return true;
  return false;
}

export const assertConflicts: Check = {
  name: 'assert-conflicts',
  run(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    const rules = ctx.config.asserts;

    // --- duplicate ids ----------------------------------------------------
    const counts = new Map<string, number>();
    for (const rule of rules) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
    for (const [id, n] of counts) {
      if (n > 1) {
        findings.push({
          check: 'assert-conflicts',
          severity: 'error',
          confidence: 'high',
          location: RULE_LOCATION,
          message: `duplicate assert id "${id}" (${n} rules share it)`,
        });
      }
    }

    // --- forbid vs require of the same command in overlapping scopes -------
    for (const forbidder of rules) {
      if (!forbidder.forbid_command) continue;
      for (const requirer of rules) {
        if (requirer === forbidder || !requirer.require_command) continue;
        const shared = forbidder.forbid_command.filter((c) =>
          requirer.require_command?.includes(c),
        );
        if (shared.length === 0) continue;
        if (!overlaps(scopePaths(forbidder, ctx), scopePaths(requirer, ctx))) continue;
        for (const cmd of shared) {
          findings.push({
            check: 'assert-conflicts',
            severity: 'error',
            confidence: 'high',
            location: RULE_LOCATION,
            message: `assert "${forbidder.id}" forbids \`${cmd}\` but assert "${requirer.id}" requires it in an overlapping doc scope`,
            suggestion: "narrow one rule's scope or add an except",
          });
        }
      }
    }

    // --- competing sources of truth -----------------------------------------
    for (let i = 0; i < rules.length; i++) {
      const a = rules[i];
      if (!a?.source || a.expect === undefined) continue;
      for (let j = i + 1; j < rules.length; j++) {
        const b = rules[j];
        if (!b?.source || b.expect === undefined) continue;
        if (a.source === b.source && a.expect !== b.expect) {
          findings.push({
            check: 'assert-conflicts',
            severity: 'error',
            confidence: 'high',
            location: RULE_LOCATION,
            message: `asserts "${a.id}" and "${b.id}" both claim ${a.source} but expect "${a.expect}" vs "${b.expect}"`,
          });
        }
      }
    }

    return findings;
  },
};
