/**
 * Virtual working-directory tracking for code blocks. Docs frequently `cd`
 * into a subdirectory before running a script — the script arg is then
 * relative to that directory, not the repo root or the doc's own dir. These
 * helpers let a check follow `cd`/`pushd` through a block so it resolves such
 * args correctly instead of false-flagging them as missing.
 */
import { posix } from 'node:path';

/** `cd <dir>` / `pushd <dir>` — the raw directory argument, else null. */
const CD_RE = /^(?:cd|pushd)\s+(\S+)/;

/**
 * If `segment` is a `cd`/`pushd` command, return its raw directory argument;
 * otherwise null. Bare `cd` (no arg → home dir) is treated as a non-match.
 */
export function parseCd(segment: string): string | null {
  const m = CD_RE.exec(segment.trim());
  return m ? m[1]! : null;
}

/**
 * Advance a virtual cwd by a `cd` argument. `''` is the repo-root-relative
 * base; `null` means UNTRACKABLE and is sticky. Returns `null` when the arg is
 * absolute (`/…`), home (`~…`), a variable (`$…`), `-`, or when normalization
 * escapes the base (`../` past root) — anything we cannot resolve to a
 * concrete repo-relative directory. Otherwise the normalized joined path,
 * trailing slash stripped.
 */
export function nextCwd(cwd: string | null, arg: string): string | null {
  if (cwd === null) return null;
  let a = arg.trim();
  // Strip surrounding quotes.
  if (
    a.length > 1 &&
    ((a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'")))
  ) {
    a = a.slice(1, -1);
  }
  if (a.length === 0) return null;
  if (a.startsWith('/') || a.startsWith('~') || a.includes('$') || a === '-') return null;
  const joined = posix.normalize(posix.join(cwd, a));
  if (joined === '.') return '';
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;
  return joined.replace(/\/+$/, '');
}
