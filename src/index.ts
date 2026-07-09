/** Public programmatic API. */
export { loadProject, runChecks, verdict } from './engine.js';
export { allChecks } from './checks/index.js';
export { runAiAdvisor } from './ai/advisor.js';
export {
  buildAdvisoryTask,
  buildAdvisoryCorpus,
  ingestAdvisories,
  mapAdvisories,
  ADVISORY_SYSTEM_PROMPT,
  ADVISORY_OUTPUT_SCHEMA,
} from './ai/host-agent.js';
export type { AdvisoryTask, RawAdvisory, AdvisoryKind } from './ai/host-agent.js';
export { bless } from './freshness/bless.js';
export { applyFixes, caseCorrectToken } from './fix.js';
export { buildInitConfig } from './init.js';
export { parseMarkdown } from './parser/markdown.js';
export { scanRepo } from './repo/scanner.js';
export { loadConfig } from './config.js';
export type * from './types.js';
