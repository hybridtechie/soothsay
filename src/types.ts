/**
 * Core data model. Every claim — extracted from prose or asserted in the
 * sidecar — is validated against RepoFacts and produces Findings.
 */

export type Severity = 'error' | 'warning' | 'info';

/** Only high-confidence errors fail CI by default. */
export type Confidence = 'high' | 'medium' | 'low';

export interface Location {
  /** Repo-relative posix path. */
  file: string;
  /** 1-based line number. */
  line: number;
}

/**
 * A mechanical, safe rewrite for a finding: replace the first occurrence of
 * `from` on `line` of `file` with `to`. Checks attach one only when the
 * rewrite is provably correct (case corrections, verified command mappings) —
 * `soothsay check --fix` applies them.
 */
export interface Fix {
  /** Repo-relative posix path of the file to edit. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Exact substring on that line to replace. */
  from: string;
  to: string;
}

export interface Finding {
  /** Check id, e.g. "path-exists". */
  check: string;
  severity: Severity;
  confidence: Confidence;
  message: string;
  location: Location;
  /** Optional actionable fix, shown to the user. */
  suggestion?: string;
  /** Machine-applicable rewrite, applied by `check --fix`. */
  fix?: Fix;
}

// ---------------------------------------------------------------------------
// Parsed markdown document
// ---------------------------------------------------------------------------

export interface Heading {
  depth: number;
  text: string;
  /** GitHub-style anchor slug. */
  slug: string;
  line: number;
}

export interface CodeBlock {
  lang: string;
  code: string;
  /** Line of the opening fence. */
  startLine: number;
  endLine: number;
}

export interface InlineCode {
  code: string;
  line: number;
}

export interface MdLink {
  text: string;
  href: string;
  line: number;
}

export interface HtmlComment {
  text: string;
  line: number;
}

export interface DocFile {
  /** Repo-relative posix path. */
  path: string;
  text: string;
  lines: string[];
  frontmatter: Record<string, unknown> | null;
  /** Set when frontmatter fences were present but YAML parsing threw. */
  frontmatterError?: string;
  headings: Heading[];
  codeBlocks: CodeBlock[];
  inlineCodes: InlineCode[];
  links: MdLink[];
  comments: HtmlComment[];
}

// ---------------------------------------------------------------------------
// Repo facts
// ---------------------------------------------------------------------------

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface RepoFacts {
  /** Absolute repo root. */
  root: string;
  /** Repo-relative posix paths of every non-ignored file. */
  files: Set<string>;
  /** Repo-relative posix paths of every non-ignored directory (including empty ones). */
  dirs: Set<string>;
  /** Lower-cased path -> actual path, for case-mismatch detection. */
  filesLower: Map<string, string>;
  /** Parsed root package.json, or null. */
  packageJson: Record<string, unknown> | null;
  /** Names of scripts in root package.json. */
  packageScripts: Set<string>;
  /** Lockfiles present at root, e.g. ["pnpm-lock.yaml"]. */
  lockfiles: string[];
  /**
   * The package manager the repo declares: packageManager field wins,
   * else inferred from a single unambiguous lockfile, else null.
   */
  packageManager: PackageManager | null;
  /** Where packageManager was determined from, for diagnostics. */
  packageManagerSource: string | null;
}

// ---------------------------------------------------------------------------
// Config (soothsay.yml)
// ---------------------------------------------------------------------------

export interface AssertRule {
  id: string;
  /** "FILE.md#heading-slug" — anchors the assert to prose. Optional. */
  doc?: string;
  /** Commands that must not appear in docs matching scope. */
  forbid_command?: string[];
  /** Commands that must appear in at least one doc matching scope. */
  require_command?: string[];
  /** Files that must exist. */
  require_file?: string[];
  /** Import specifier glob that must not appear in source files under `in`. */
  forbid_import?: string;
  /** Source-file scope for forbid_import, e.g. "src/api/**". */
  in?: string;
  /** Glob exceptions for forbid_import. */
  except?: string[];
  /** "file.json#dot.path" whose value must equal `expect`. */
  source?: string;
  /** Compared as strings — YAML scalars (numbers, booleans) are coerced. */
  expect?: string | number | boolean;
  /** Agent file whose frontmatter tools must be a subset of `allowed`. */
  agent?: string;
  allowed?: string[];
  /** Doc-glob scope for command asserts. Default: all scanned docs. */
  scope?: string;
}

export interface SoothsayConfig {
  /** Doc globs to scan. */
  docs: string[];
  /** Globs to exclude from doc selection (not from repo facts). */
  ignore: string[];
  /** Check ids to disable. */
  disable: string[];
  asserts: AssertRule[];
  /**
   * Set when a config file exists but could not be read or parsed. The
   * defaults above are in effect, and the engine surfaces this as an error
   * finding so CI never goes silently green with zero asserts.
   */
  configError?: string;
}

export const DEFAULT_DOC_GLOBS = [
  'CLAUDE.md',
  'AGENTS.md',
  'README.md',
  '.claude/**/*.md',
  '.cursor/rules/**/*.md*',
  'docs/**/*.md',
  '**/SKILL.md',
];

/**
 * Default ignore globs for DOC selection (which markdown files are scanned).
 * Repo FACTS deliberately use a narrower list (see repo/scanner.ts): a doc
 * linking a committed dist/ artifact must not be a false broken-link error.
 */
export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.venv/**',
  '**/vendor/**',
];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface CheckContext {
  repo: RepoFacts;
  docs: DocFile[];
  config: SoothsayConfig;
}

export interface Check {
  name: string;
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}
