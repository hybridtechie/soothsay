/**
 * Gitignore awareness: a doc that mentions `.venv/bin/activate` or a
 * gitignored `token.json` is describing runtime state, not drift. Checks
 * batch their missing candidates through filterIgnored and silently skip
 * the ones git ignores.
 */
import { execFileSync } from 'node:child_process';

/**
 * Return the subset of `paths` (repo-relative posix) that git ignores in
 * `root`, via one batched `git check-ignore --stdin -z` call.
 *
 * Each candidate is queried both as given and with a trailing slash
 * appended: dir-only patterns like `archive/emails/` do not match a bare
 * `archive/emails` query when the path does not exist on disk, because git
 * cannot tell it is a directory.
 *
 * Exit code 1 with no output means nothing is ignored; any other failure
 * (not a git repo, git missing, bad root) yields an empty set.
 */
export function filterIgnored(root: string, paths: string[]): Set<string> {
  const ignored = new Set<string>();
  if (paths.length === 0) return ignored;

  // query form -> original candidates it stands for
  const byQuery = new Map<string, string[]>();
  for (const p of paths) {
    const bare = p.replace(/\/+$/, '');
    if (bare.length === 0) continue;
    for (const q of [bare, `${bare}/`]) {
      const originals = byQuery.get(q);
      if (originals) {
        if (!originals.includes(p)) originals.push(p);
      } else {
        byQuery.set(q, [p]);
      }
    }
  }
  if (byQuery.size === 0) return ignored;

  let stdout: string;
  try {
    stdout = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: root,
      input: [...byQuery.keys()].join('\0'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    // Exit code 1: no path is ignored. Anything else: fail open (empty set).
    const status = (err as { status?: number | null }).status;
    if (status !== 1) return ignored;
    stdout = '';
  }

  for (const line of stdout.split('\0')) {
    if (line.length === 0) continue;
    for (const original of byQuery.get(line) ?? []) ignored.add(original);
  }
  return ignored;
}
