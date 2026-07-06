import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  DEFAULT_DOC_GLOBS,
  DEFAULT_IGNORE,
  type AssertRule,
  type SoothsayConfig,
} from './types.js';

export const CONFIG_FILENAMES = ['soothsay.yml', 'soothsay.yaml', '.soothsay.yml'];

/**
 * Load soothsay.yml if present; otherwise sensible zero-config defaults.
 * A missing file is fine (defaults). A file that exists but cannot be read
 * or parsed must NOT silently disable asserts: the returned config carries
 * `configError` and the engine turns it into a blocking finding.
 */
export function loadConfig(root: string): SoothsayConfig {
  let raw: Record<string, unknown> = {};
  let configError: string | undefined;

  for (const name of CONFIG_FILENAMES) {
    let text: string;
    try {
      text = readFileSync(join(root, name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // missing — try next
      configError = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    let parsed: unknown;
    try {
      parsed = YAML.parse(text);
    } catch (err) {
      configError = `${name}: invalid YAML — ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    if (parsed === null || parsed === undefined) break; // empty config = defaults
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      configError = `${name}: config must be a YAML mapping (got ${Array.isArray(parsed) ? 'a list' : typeof parsed})`;
      break;
    }
    raw = parsed as Record<string, unknown>;
    break;
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const config: SoothsayConfig = {
    docs: strings(raw.docs).length > 0 ? strings(raw.docs) : [...DEFAULT_DOC_GLOBS],
    ignore: [...DEFAULT_IGNORE, ...strings(raw.ignore)],
    disable: strings(raw.disable),
    asserts: Array.isArray(raw.asserts)
      ? raw.asserts.filter((a): a is AssertRule => !!a && typeof a === 'object' && 'id' in a)
      : [],
  };
  if (configError !== undefined) config.configError = configError;
  return config;
}
