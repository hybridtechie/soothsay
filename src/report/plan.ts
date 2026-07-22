/**
 * Decide whether to write the HTML report and whether to open it — the pure
 * core of `soothsay check`'s reporting side output, kept separate from the CLI
 * so every branch is testable without a real TTY or browser.
 *
 * Default behavior: in an interactive terminal, a run that finds something
 * writes a throwaway report and opens it in the browser. That auto-open is
 * suppressed when output is piped, in machine modes (`--json`/`--github`),
 * under CI, or with `--no-open`. Explicit flags override the default.
 */
export interface ReportFlags {
  /** --html: write a persistent artifact in the project dir. */
  html: boolean;
  /** --html-file <path>: write the artifact to this path. */
  htmlFile?: string;
  /** --open: force-open even when output is piped. */
  open: boolean;
  /** --no-open: never auto-open. */
  noOpen: boolean;
  /** --json / --github: machine output modes — no auto-open. */
  json: boolean;
  github: boolean;
  /** process.stdout.isTTY — a human is watching. */
  isTty: boolean;
  /** $CI — a browser makes no sense here. */
  isCI: boolean;
  /** Any findings to show. */
  hasFindings: boolean;
}

export interface ReportPlan {
  write: boolean;
  open: boolean;
  /** 'file' → use htmlFile; 'cwd' → soothsay-report.html in project; 'temp' → OS temp dir. */
  location: 'file' | 'cwd' | 'temp';
}

export function planHtmlReport(f: ReportFlags): ReportPlan {
  const interactive = !f.json && !f.github && f.isTty && !f.isCI;
  const wantsArtifact = f.html || f.htmlFile !== undefined;

  let open = false;
  if (!f.noOpen && f.hasFindings && !f.isCI) {
    // Explicit --open forces it (even when piped); otherwise auto-open only
    // when a human is watching an interactive terminal.
    open = f.open || interactive;
  }

  const write = wantsArtifact || open;

  const location: ReportPlan['location'] =
    f.htmlFile !== undefined ? 'file' : f.html ? 'cwd' : 'temp';

  return { write, open, location };
}
