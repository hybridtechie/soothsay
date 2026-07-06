import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageManager, RepoFacts } from '../types.js';

const LOCKFILE_PM: Record<string, PackageManager> = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
};

/**
 * Facts must reflect everything committed on disk — a doc that links a
 * committed dist/index.js is telling the truth. Only VCS internals and
 * dependency trees are excluded here; doc SELECTION uses the broader
 * DEFAULT_IGNORE (plus user ignores) in loadProject.
 */
const FACTS_IGNORE = ['**/node_modules/**', '**/.git/**'];

/** Build the repo fact base every check validates against. */
export async function scanRepo(root: string): Promise<RepoFacts> {
  const ignore = FACTS_IGNORE;
  const paths = await fg('**/*', {
    cwd: root,
    dot: true,
    onlyFiles: true,
    ignore,
  });
  const dirPaths = await fg('**/*', {
    cwd: root,
    dot: true,
    onlyDirectories: true,
    ignore,
  });

  const files = new Set(paths);
  const dirs = new Set(dirPaths);
  const filesLower = new Map<string, string>();
  for (const p of paths) filesLower.set(p.toLowerCase(), p);

  let packageJson: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') packageJson = parsed;
  } catch {
    packageJson = null;
  }

  const packageScripts = new Set<string>(
    Object.keys((packageJson?.scripts as Record<string, string> | undefined) ?? {}),
  );

  const lockfiles = Object.keys(LOCKFILE_PM).filter((f) => files.has(f));

  let packageManager: PackageManager | null = null;
  let packageManagerSource: string | null = null;

  const pmField = packageJson?.packageManager;
  if (typeof pmField === 'string') {
    const name = pmField.split('@')[0] as PackageManager;
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
      packageManager = name;
      packageManagerSource = 'package.json#packageManager';
    }
  }
  if (!packageManager) {
    const inferred = new Set(lockfiles.map((f) => LOCKFILE_PM[f]!));
    if (inferred.size === 1) {
      packageManager = [...inferred][0]!;
      packageManagerSource = lockfiles[0]!;
    }
  }

  return {
    root,
    files,
    dirs,
    filesLower,
    packageJson,
    packageScripts,
    lockfiles,
    packageManager,
    packageManagerSource,
  };
}
