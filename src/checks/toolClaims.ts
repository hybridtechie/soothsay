/**
 * tool-claim-mismatch: an agent that describes itself as read-only must not
 * be granted tools that can write.
 */
import type { Check, Finding } from '../types.js';

const READ_ONLY_CLAIM_RE =
  /read[\s-]?only|only\s+reads|never\s+(writes?|edits?|modif\w+|creates?\s+files)|must\s+not\s+(write|edit|modify)|no\s+write\s+access|does\s+not\s+(write|edit|modify)|cannot\s+(write|edit|modify)/i;

/**
 * Body prose only counts as a read-only claim when the sentence is about the
 * agent itself ("this agent is read-only", "you are a read-only reviewer") —
 * not when it describes something else, e.g. a folder listed as
 * "dashboards/ # Aggregated views (read-only, not validated)".
 */
const BODY_SELF_CLAIM_RE =
  /\b(this agent|the agent|you are|agent is)\b[^.\n]{0,80}(read[\s-]?only|never writes)/i;

const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];

export const toolClaims: Check = {
  name: 'tool-claim-mismatch',
  run(ctx) {
    const findings: Finding[] = [];

    for (const doc of ctx.docs) {
      if (!doc.path.includes('.claude/agents/')) continue;

      const fm = doc.frontmatter ?? {};
      const description = typeof fm['description'] === 'string' ? fm['description'] : '';
      const claimsReadOnly =
        READ_ONLY_CLAIM_RE.test(description) || BODY_SELF_CLAIM_RE.test(doc.text);
      if (!claimsReadOnly) continue;

      const rawTools = fm['tools'];
      let tools: string[] = [];
      if (Array.isArray(rawTools)) {
        tools = rawTools.filter((t): t is string => typeof t === 'string');
      } else if (typeof rawTools === 'string') {
        tools = rawTools
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }

      const location = { file: doc.path, line: 1 };

      if (tools.length === 0) {
        findings.push({
          check: 'tool-claim-mismatch',
          severity: 'warning',
          confidence: 'medium',
          message:
            'agent claims to be read-only but declares no tools restriction (inherits all tools, including Write/Edit)',
          location,
        });
        continue;
      }

      for (const tool of tools) {
        if (!WRITE_TOOLS.includes(tool)) continue;
        findings.push({
          check: 'tool-claim-mismatch',
          severity: 'error',
          confidence: 'high',
          message: `agent claims to be read-only but has the ${tool} tool`,
          location,
          suggestion: `Remove ${tool} from the tools list, or drop the read-only claim`,
        });
      }
    }

    return findings;
  },
};
