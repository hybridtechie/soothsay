import type { Check } from '../types.js';
import { pathExists } from './pathExists.js';
import { linkValid } from './linkValid.js';
import { skillResources } from './skillResources.js';
import { commandExists } from './commandExists.js';
import { packageManagerConsistent } from './packageManagerConsistent.js';
import { frontmatterValid } from './frontmatterValid.js';
import { toolClaims } from './toolClaims.js';
import { makeFreshnessCheck } from '../freshness/check.js';
import { assertsCheck } from '../asserts/run.js';
import { assertConflicts } from '../asserts/conflicts.js';

/** All deterministic checks, in run order. Layer 3 (--ai) is opt-in and separate. */
export function allChecks(): Check[] {
  return [
    // Layer 0 — zero-config extraction
    pathExists,
    linkValid,
    skillResources,
    commandExists,
    packageManagerConsistent,
    frontmatterValid,
    toolClaims,
    // Layer 1 — freshness
    makeFreshnessCheck(),
    // Layer 2 — sidecar assertions
    assertsCheck,
    assertConflicts,
  ];
}
