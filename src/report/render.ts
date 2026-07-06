import type { Finding } from '../types.js';
import type { Verdict } from '../engine.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s: string) => paint('31', s);
const yellow = (s: string) => paint('33', s);
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);
const green = (s: string) => paint('32', s);

const MARK: Record<Finding['severity'], string> = {
  error: red('✗'),
  warning: yellow('⚠'),
  info: dim('ℹ'),
};

/**
 * Human terminal output, grouped by file. `fixed` (when --fix ran) is the
 * number of autofixes applied before this report.
 */
export function renderTty(findings: Finding[], v: Verdict, fixed?: number): string {
  const lines: string[] = [bold('soothsay check'), ''];
  if (fixed !== undefined) {
    lines.push(
      fixed > 0
        ? green(`✔ applied ${fixed} autofix(es); re-checked from disk`)
        : dim('no applicable autofixes'),
      '',
    );
  }
  if (findings.length === 0) {
    lines.push(green('✓ no findings — your docs tell the truth'));
    return lines.join('\n');
  }

  let currentFile = '';
  for (const f of findings) {
    if (f.location.file !== currentFile) {
      currentFile = f.location.file;
      lines.push(bold(currentFile));
    }
    const conf = f.confidence === 'high' ? '' : dim(` (${f.confidence} confidence)`);
    lines.push(`  ${MARK[f.severity]} ${dim(`L${f.location.line}`)} [${f.check}] ${f.message}${conf}`);
    if (f.suggestion) lines.push(`      ${dim('→ ' + f.suggestion)}`);
  }

  const fixable = findings.filter((f) => f.fix).length;
  lines.push(
    '',
    `${v.errors} error(s), ${v.warnings} warning(s), ${v.infos} info — ${
      v.failed ? red('FAIL') : green('PASS')
    }`,
  );
  if (fixable > 0 && fixed === undefined) {
    lines.push(dim(`${fixable} finding(s) auto-fixable — run \`soothsay check --fix\``));
  }
  return lines.join('\n');
}

/** Escape workflow-command message data: % first, then CR/LF. */
function escapeGhData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Sanitize property values (file, title): `,`/`:`/newlines break the syntax. */
function sanitizeGhProperty(s: string): string {
  return s.replace(/[,:\r\n]/g, '_');
}

/** GitHub Actions workflow-command annotations. */
export function renderGithub(findings: Finding[]): string {
  return findings
    .map((f) => {
      const level = f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'notice';
      const msg = escapeGhData(f.message + (f.suggestion ? ` — ${f.suggestion}` : ''));
      const file = sanitizeGhProperty(f.location.file);
      const title = sanitizeGhProperty(`soothsay ${f.check}`);
      return `::${level} file=${file},line=${f.location.line},title=${title}::${msg}`;
    })
    .join('\n');
}

export function renderJson(findings: Finding[], v: Verdict, fixed?: number): string {
  const summary = fixed === undefined ? v : { ...v, fixed };
  return JSON.stringify({ findings, summary }, null, 2);
}
