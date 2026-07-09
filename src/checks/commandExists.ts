/**
 * command-exists: every command a doc tells the agent to run must be
 * runnable — package scripts must exist in package.json, and files passed
 * to interpreters must exist on disk.
 */
import { posix } from 'node:path';
import type { Check, Confidence, DocFile, Finding } from '../types.js';
import { isNoiseToken, resolveCandidate } from './pathExists.js';
import { filterIgnored } from '../repo/ignored.js';
import { caseCorrectToken } from '../fix.js';
import { parseCd, nextCwd } from './cwd.js';

export interface ExtractedCommand {
  cmd: string;
  /** 1-based line in the doc. */
  line: number;
  fromFence: boolean;
  /**
   * Virtual working directory (repo-root-relative) established by a preceding
   * `cd`/`pushd` in the same fenced block. Absent when there was no `cd`
   * (repo-root base); `null` when the cwd is untrackable (`cd $VAR`, etc.).
   */
  cwd?: string | null;
}

/** Fence languages treated as shell. */
const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console']);

/** Inline code must start with one of these to be treated as a command. */
const INLINE_COMMAND_RE =
  /^(?:npm|pnpm|yarn|bun|npx|node|python3?|bash|sh|deno|tsx|ts-node)\b|^\.\//;

/** Builtin package-manager subcommands that are not package scripts. */
const PM_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'init', 'publish',
  'pack', 'link', 'exec', 'dlx', 'create', 'audit', 'outdated', 'why', 'list',
  'ls', 'view', 'info', 'config', 'help', 'login', 'logout', 'ci', 'test',
  'start', 'run', 'store', 'prune', 'rebuild', 'setup', 'self-update',
  'import', 'dedupe', 'patch', 'version', 'cache', 'whoami', 'search',
]);

function splitChained(text: string): string[] {
  return text
    .split(/&&|;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/;

/** Strip leading `sudo ` and env assignments (`FOO=bar cmd ...`). */
function stripEnvAndSudo(seg: string): string {
  let s = seg.trim();
  for (;;) {
    if (/^sudo\s/.test(s)) {
      s = s.replace(/^sudo\s+/, '');
      continue;
    }
    const m = ENV_ASSIGN_RE.exec(s);
    if (m) {
      s = s.slice(m[0]!.length);
      continue;
    }
    return s;
  }
}

/** Heredoc opener (`<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<-WORD`) — not `<<<`. */
const HEREDOC_RE = /(?<!<)<<-?\s*(['"]?)(\w+)\1/;

/** Pull every command-looking string out of a doc's fences and inline code. */
export function extractCommands(doc: DocFile): ExtractedCommand[] {
  const out: ExtractedCommand[] = [];

  for (const block of doc.codeBlocks) {
    if (!SHELL_LANGS.has(block.lang)) continue;
    const codeLines = block.code.split('\n');
    let heredocEnd: string | null = null;
    // Virtual cwd for this block: '' = repo-root base, null = untrackable.
    let cwd: string | null = '';
    for (let i = 0; i < codeLines.length; i++) {
      // Heredoc bodies are data, not commands.
      if (heredocEnd !== null) {
        if ((codeLines[i] ?? '').trim() === heredocEnd) heredocEnd = null;
        continue;
      }
      const lineNo = block.startLine + 1 + i;
      // Join backslash continuations onto one logical line.
      let raw = codeLines[i] ?? '';
      while (raw.trimEnd().endsWith('\\') && i + 1 < codeLines.length) {
        raw = `${raw.trimEnd().slice(0, -1).trimEnd()} ${(codeLines[i + 1] ?? '').trim()}`;
        i++;
      }
      let line = raw.trim();
      if (line.startsWith('$ ') || line.startsWith('> ')) line = line.slice(2).trim();
      if (line === '' || line.startsWith('#')) continue;
      const hd = HEREDOC_RE.exec(line);
      if (hd) heredocEnd = hd[2]!;
      for (const seg of splitChained(line)) {
        const cmd = stripEnvAndSudo(seg);
        if (cmd.length === 0) continue;
        // Attach the cwd in effect *before* this segment runs, then let a
        // leading `cd`/`pushd` advance it for subsequent segments/lines.
        out.push({ cmd, line: lineNo, fromFence: true, ...(cwd !== '' ? { cwd } : {}) });
        const cdArg = parseCd(cmd);
        if (cdArg !== null) cwd = nextCwd(cwd, cdArg);
      }
    }
  }

  for (const ic of doc.inlineCodes) {
    const content = stripEnvAndSudo(ic.code.trim());
    if (!INLINE_COMMAND_RE.test(content)) continue;
    for (const seg of splitChained(content)) {
      const cmd = stripEnvAndSudo(seg);
      if (cmd.length === 0) continue;
      out.push({ cmd, line: ic.line, fromFence: false });
    }
  }

  return out;
}

const RUN_PREFIX_RE = /^(npm|pnpm|yarn|bun)\s+run\s+(\S.*)$/;
const SCRIPT_NAME_RE = /^[\w:.-]+$/;

/**
 * Parse `<pm> run [flags] <script>` — flag tokens (`--workspace=api`, `-s`,
 * bare `--`) are skipped; the first non-flag token is the script name.
 * Returns null when there is no plausible script token to validate.
 */
export function parseRunScript(cmd: string): { display: string; script: string } | null {
  const m = RUN_PREFIX_RE.exec(cmd);
  if (!m) return null;
  const seen: string[] = [];
  for (const token of m[2]!.split(/\s+/)) {
    seen.push(token);
    if (token.startsWith('-')) continue; // flag (or `--` separator)
    if (!SCRIPT_NAME_RE.test(token)) return null; // not a plausible script name
    return { display: `${m[1]} run ${seen.join(' ')}`, script: token };
  }
  return null; // flags only — nothing to validate
}
const LIFECYCLE_RE = /^(npm|pnpm|yarn)\s+(test|start)\b/;
const PM_SHORTHAND_RE = /^(pnpm|yarn)\s+([\w:.-]+)/;
const FILE_RUNNER_RE = /^(?:python3?|node|bash|sh|tsx|ts-node)\s+(\S+)/;
const NPX_TSX_RE = /^npx\s+tsx\s+(\S+)/;
const FILE_EXT_RE = /\.(?:py|js|ts|sh|mjs|cjs)$/;
const UNSAFE_PATH_RE = /[$`*]/;

export const commandExists: Check = {
  name: 'command-exists',
  run(ctx) {
    const findings: Finding[] = [];
    const { repo } = ctx;

    // Missing-file findings are deferred so gitignored paths can be dropped
    // in one batched filterIgnored call per run.
    const pending: { finding: Finding; keys: string[] }[] = [];

    for (const doc of ctx.docs) {
      for (const { cmd, line, fromFence, cwd } of extractCommands(doc)) {
        const location = { file: doc.path, line };
        const confidence: Confidence = fromFence ? 'high' : 'medium';

        // --- (a) package-script invocations -------------------------------
        if (repo.packageJson !== null) {
          const runM = parseRunScript(cmd);
          if (runM) {
            if (!repo.packageScripts.has(runM.script)) {
              findings.push({
                check: 'command-exists',
                severity: 'error',
                confidence,
                message: `\`${runM.display}\` refers to script "${runM.script}" which does not exist in package.json`,
                location,
              });
            }
            continue;
          }

          const lifeM = LIFECYCLE_RE.exec(cmd);
          if (lifeM && !(lifeM[1] === 'yarn' && lifeM[2] === 'start')) {
            const script = lifeM[2]!;
            if (!repo.packageScripts.has(script)) {
              findings.push({
                check: 'command-exists',
                severity: 'error',
                confidence,
                message: `\`${lifeM[0]}\` refers to script "${script}" which does not exist in package.json`,
                location,
              });
            }
            continue;
          }

          const shortM = PM_SHORTHAND_RE.exec(cmd);
          if (shortM && repo.packageScripts.size > 0) {
            const name = shortM[2]!;
            if (
              !name.startsWith('-') &&
              !PM_BUILTINS.has(name) &&
              !repo.packageScripts.has(name)
            ) {
              findings.push({
                check: 'command-exists',
                severity: 'warning',
                confidence: 'medium',
                message: `\`${shortM[0]}\` refers to possibly missing script "${name}" — not a ${shortM[1]} builtin and not in package.json scripts`,
                location,
              });
            }
            continue;
          }
        }

        // --- (b) file-running commands -------------------------------------
        let rawPath: string | null = null;
        const fileM = FILE_RUNNER_RE.exec(cmd) ?? NPX_TSX_RE.exec(cmd);
        if (fileM) {
          rawPath = fileM[1]!;
        } else if (cmd.startsWith('./')) {
          rawPath = cmd.split(/\s+/)[0]!;
        }
        if (rawPath === null || rawPath.startsWith('-')) continue;
        if (UNSAFE_PATH_RE.test(rawPath)) continue;
        if (rawPath.startsWith('/')) continue;
        if (isNoiseToken(rawPath)) continue;
        if (!rawPath.includes('/') && !FILE_EXT_RE.test(rawPath)) continue;
        // Ran under an untrackable cwd (`cd $VAR`, `cd /abs`, …) — we cannot
        // resolve the arg, so suppress rather than risk a false positive.
        if (cwd === null) continue;

        const path = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
        // Resolve from the repo root, the doc's own directory, and any virtual
        // cwd established by a preceding `cd`/`pushd` in the same block.
        const resolutions = resolveCandidate(doc.path, path);
        if (typeof cwd === 'string' && cwd.length > 0) {
          const underCwd = posix.normalize(posix.join(cwd, path));
          if (!resolutions.includes(underCwd)) resolutions.push(underCwd);
        }
        if (resolutions.some((r) => repo.files.has(r))) continue;

        const actual = resolutions
          .map((r) => repo.filesLower.get(r.toLowerCase()))
          .find((a) => a !== undefined);
        if (actual) {
          const corrected = caseCorrectToken(path, actual);
          findings.push({
            check: 'command-exists',
            severity: 'error',
            confidence: 'high',
            message: `command references \`${path}\` which does not exist (case mismatch with \`${actual}\`)`,
            location,
            suggestion: `Did you mean \`${actual}\`?`,
            ...(corrected
              ? { fix: { ...location, from: path, to: corrected } }
              : {}),
          });
        } else {
          pending.push({
            finding: {
              check: 'command-exists',
              severity: 'error',
              confidence,
              message: `command references \`${path}\` which does not exist`,
              location,
            },
            keys: resolutions,
          });
        }
      }
    }

    if (pending.length > 0) {
      const ignored = filterIgnored(repo.root, [
        ...new Set(pending.flatMap((p) => p.keys)),
      ]);
      for (const p of pending) {
        if (p.keys.some((k) => ignored.has(k))) continue;
        findings.push(p.finding);
      }
    }

    return findings;
  },
};
