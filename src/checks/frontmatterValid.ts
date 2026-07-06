/**
 * frontmatter-valid: SKILL.md and .claude/agents/*.md files must carry the
 * frontmatter their loaders require.
 */
import type { Check, DocFile, Finding } from '../types.js';

const AGENT_PATH_RE = /(?:^|\/)\.claude\/agents\/[^/]+\.md$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_DESCRIPTION = 1024;

function error(doc: DocFile, message: string): Finding {
  return {
    check: 'frontmatter-valid',
    severity: 'error',
    confidence: 'high',
    message,
    location: { file: doc.path, line: 1 },
  };
}

function warning(doc: DocFile, message: string): Finding {
  return {
    check: 'frontmatter-valid',
    severity: 'warning',
    confidence: 'medium',
    message,
    location: { file: doc.path, line: 1 },
  };
}

function checkNameAndDescription(doc: DocFile, fm: Record<string, unknown>, kind: string): Finding[] {
  const findings: Finding[] = [];
  if (typeof fm['name'] !== 'string') {
    findings.push(error(doc, `${kind} frontmatter is missing required string field "name"`));
  } else if (!NAME_RE.test(fm['name'])) {
    findings.push(
      warning(doc, `${kind} "name" should match ^[a-z0-9][a-z0-9-]*$ (got "${fm['name']}")`),
    );
  }
  if (typeof fm['description'] !== 'string') {
    findings.push(error(doc, `${kind} frontmatter is missing required string field "description"`));
  } else if (fm['description'].length > MAX_DESCRIPTION) {
    findings.push(
      warning(doc, `${kind} "description" is ${fm['description'].length} chars (max ${MAX_DESCRIPTION})`),
    );
  }
  return findings;
}

export const frontmatterValid: Check = {
  name: 'frontmatter-valid',
  run(ctx) {
    const findings: Finding[] = [];

    for (const doc of ctx.docs) {
      if (doc.path.endsWith('SKILL.md')) {
        if (!doc.frontmatter) {
          findings.push(error(doc, 'SKILL.md has no frontmatter (name and description required)'));
          continue;
        }
        findings.push(...checkNameAndDescription(doc, doc.frontmatter, 'skill'));
        continue;
      }

      if (AGENT_PATH_RE.test(doc.path)) {
        if (!doc.frontmatter) {
          findings.push(error(doc, 'agent file has no frontmatter (name and description required)'));
          continue;
        }
        findings.push(...checkNameAndDescription(doc, doc.frontmatter, 'agent'));
        if ('tools' in doc.frontmatter) {
          const tools = doc.frontmatter['tools'];
          const valid =
            typeof tools === 'string' ||
            (Array.isArray(tools) && tools.every((t) => typeof t === 'string'));
          if (!valid) {
            findings.push(error(doc, 'agent "tools" must be a string or an array of strings'));
          }
        }
      }
    }

    return findings;
  },
};
