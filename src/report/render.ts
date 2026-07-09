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

/** Escape text for safe interpolation into HTML — docs are untrusted input. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SEV_MARK: Record<Finding['severity'], string> = {
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
};

const HTML_STYLE = `
:root {
  --bg: #ffffff; --panel: #f6f8fa; --border: #d0d7de; --text: #1f2328;
  --muted: #656d76; --error: #cf222e; --warning: #9a6700; --info: #57606a;
  --pass: #1a7f37; --fail: #cf222e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3;
    --muted: #8b949e; --error: #ff7b72; --warning: #e3b341; --info: #8b949e;
    --pass: #3fb950; --fail: #ff7b72;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
main { max-width: 960px; margin: 0 auto; }
header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem; }
h1 { font-size: 1.35rem; margin: 0; }
.verdict { font-weight: 700; padding: .15rem .6rem; border-radius: 999px; font-size: .85rem; letter-spacing: .04em; }
.verdict.pass { background: color-mix(in srgb, var(--pass) 18%, transparent); color: var(--pass); }
.verdict.fail { background: color-mix(in srgb, var(--fail) 18%, transparent); color: var(--fail); }
.tallies { display: flex; gap: .5rem; flex-wrap: wrap; margin: 0 0 1.25rem; padding: 0; list-style: none; }
.tallies li { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: .3rem .7rem; font-size: .85rem; }
.note { color: var(--muted); font-size: .9rem; margin: 0 0 1rem; }
.clean { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; text-align: center; color: var(--pass); font-weight: 600; }
section.file { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1rem; overflow: hidden; }
section.file > h2 { margin: 0; padding: .6rem .9rem; background: var(--panel); border-bottom: 1px solid var(--border); font-size: .95rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.finding { display: grid; grid-template-columns: 1.4rem 3.2rem 1fr; gap: .5rem; padding: .6rem .9rem; border-top: 1px solid var(--border); }
.finding:first-of-type { border-top: none; }
.finding .mark { font-weight: 700; text-align: center; }
.finding.error .mark { color: var(--error); }
.finding.warning .mark { color: var(--warning); }
.finding.info .mark { color: var(--info); }
.finding .line { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
.finding .body .check { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; color: var(--muted); }
.finding .body .conf { color: var(--muted); font-size: .8rem; }
.finding .body .suggestion { color: var(--muted); font-size: .88rem; margin-top: .25rem; }
footer { color: var(--muted); font-size: .8rem; margin-top: 2rem; text-align: center; }
`.trim();

/**
 * Self-contained HTML report — grouped by file, no external assets. Written to
 * disk by `soothsay check --html` and opened by `--open`. `fixed` (when --fix
 * ran) is the number of autofixes applied before this report.
 */
export function renderHtml(findings: Finding[], v: Verdict, fixed?: number): string {
  const verdictClass = v.failed ? 'fail' : 'pass';
  const verdictLabel = v.failed ? 'FAIL' : 'PASS';

  const parts: string[] = [];
  parts.push(
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>soothsay report</title>',
    `<style>${HTML_STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<header>',
    '<h1>soothsay check</h1>',
    `<span class="verdict ${verdictClass}">${verdictLabel}</span>`,
    '</header>',
    '<ul class="tallies">',
    `<li>${v.errors} error${v.errors === 1 ? '' : 's'}</li>`,
    `<li>${v.warnings} warning${v.warnings === 1 ? '' : 's'}</li>`,
    `<li>${v.infos} info</li>`,
    '</ul>',
  );

  if (fixed !== undefined) {
    parts.push(
      `<p class="note">${
        fixed > 0 ? `Applied ${fixed} autofix(es); re-checked from disk.` : 'No applicable autofixes.'
      }</p>`,
    );
  }

  if (findings.length === 0) {
    parts.push('<div class="clean">✓ no findings — your docs tell the truth</div>');
  } else {
    let currentFile = '';
    let open = false;
    for (const f of findings) {
      if (f.location.file !== currentFile) {
        if (open) parts.push('</section>');
        currentFile = f.location.file;
        parts.push('<section class="file">', `<h2>${esc(currentFile)}</h2>`);
        open = true;
      }
      const conf =
        f.confidence === 'high' ? '' : ` <span class="conf">(${esc(f.confidence)} confidence)</span>`;
      const suggestion = f.suggestion
        ? `<div class="suggestion">→ ${esc(f.suggestion)}</div>`
        : '';
      parts.push(
        `<div class="finding ${f.severity}">`,
        `<span class="mark">${SEV_MARK[f.severity]}</span>`,
        `<span class="line">L${f.location.line}</span>`,
        '<div class="body">',
        `<span class="check">[${esc(f.check)}]</span> ${esc(f.message)}${conf}`,
        suggestion,
        '</div>',
        '</div>',
      );
    }
    if (open) parts.push('</section>');
  }

  parts.push(
    '<footer>Generated by soothsay — your agent docs make claims, soothsay proves them.</footer>',
    '</main>',
    '</body>',
    '</html>',
  );
  return parts.join('\n');
}
