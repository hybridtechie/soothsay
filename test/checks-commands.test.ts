import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../src/parser/markdown.js';
import { commandExists, extractCommands } from '../src/checks/commandExists.js';
import { parseCd, nextCwd } from '../src/checks/cwd.js';
import { packageManagerConsistent } from '../src/checks/packageManagerConsistent.js';
import { frontmatterValid } from '../src/checks/frontmatterValid.js';
import { toolClaims } from '../src/checks/toolClaims.js';
import type { CheckContext, DocFile, RepoFacts } from '../src/types.js';

function makeRepo(overrides: Partial<RepoFacts> = {}): RepoFacts {
  const files = overrides.files ?? new Set(['scripts/Sync.py', 'src/index.ts', 'package.json']);
  const filesLower = new Map<string, string>();
  for (const f of files) filesLower.set(f.toLowerCase(), f);
  return {
    root: '/fake',
    dirs: new Set(),
    packageJson: { name: 'fixture', scripts: { test: 'vitest run', build: 'tsc' } },
    packageScripts: new Set(['test', 'build']),
    lockfiles: ['pnpm-lock.yaml'],
    packageManager: 'pnpm',
    packageManagerSource: 'package.json#packageManager',
    ...overrides,
    files,
    filesLower: overrides.filesLower ?? filesLower,
  };
}

function makeCtx(docs: DocFile[], repoOverrides: Partial<RepoFacts> = {}): CheckContext {
  return {
    repo: makeRepo(repoOverrides),
    docs,
    config: { docs: [], ignore: [], disable: [], asserts: [] },
  };
}

// ---------------------------------------------------------------------------
// extractCommands
// ---------------------------------------------------------------------------

describe('extractCommands', () => {
  it('extracts commands from bash fences, stripping prompts and skipping comments', () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      '# T\n\n```bash\n# a comment\n$ pnpm run build\n\nnode src/index.ts\n```\n',
    );
    const cmds = extractCommands(doc);
    expect(cmds).toEqual([
      { cmd: 'pnpm run build', line: 5, fromFence: true },
      { cmd: 'node src/index.ts', line: 7, fromFence: true },
    ]);
  });

  it('splits chained commands on && and ;', () => {
    const doc = parseMarkdown('CLAUDE.md', '```sh\ncd app && npm run build; npm test\n```\n');
    const cmds = extractCommands(doc).map((c) => c.cmd);
    expect(cmds).toEqual(['cd app', 'npm run build', 'npm test']);
  });

  it('extracts inline codes only when they start with a known command word', () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      'Run `pnpm run build` then `./scripts/go.sh` but not `git status` or `some prose`.\n',
    );
    const cmds = extractCommands(doc);
    expect(cmds.map((c) => c.cmd)).toEqual(['pnpm run build', './scripts/go.sh']);
    expect(cmds.every((c) => c.fromFence === false)).toBe(true);
  });
});

describe('extractCommands: heredocs, sudo/env prefixes, continuations', () => {
  it('skips heredoc bodies (plain, quoted, and <<- forms)', () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      [
        '```bash',
        'cat <<EOF > out.txt',
        'python scripts/gone.py',
        'EOF',
        "cat <<'DONE'",
        'node scripts/also-gone.js',
        'DONE',
        'cat <<-END',
        '\tbash scripts/nope.sh',
        'END',
        'python scripts/real.py',
        '```',
      ].join('\n'),
    );
    const cmds = extractCommands(doc).map((c) => c.cmd);
    expect(cmds).toContain('python scripts/real.py');
    expect(cmds).not.toContain('python scripts/gone.py');
    expect(cmds).not.toContain('node scripts/also-gone.js');
    expect(cmds).not.toContain('bash scripts/nope.sh');
  });

  it('strips leading sudo and env assignments', () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      '```bash\nsudo npm install\nNODE_ENV=production FOO="a b" npm run build\n```\n' +
        'Also `sudo node src/index.ts` inline.\n',
    );
    const cmds = extractCommands(doc).map((c) => c.cmd);
    expect(cmds).toContain('npm install');
    expect(cmds).toContain('npm run build');
    expect(cmds).toContain('node src/index.ts');
  });

  it('joins fence lines that end in a backslash', () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npnpm run \\\n  build\n```\n');
    const cmds = extractCommands(doc);
    expect(cmds).toEqual([{ cmd: 'pnpm run build', line: 2, fromFence: true }]);
  });
});

// ---------------------------------------------------------------------------
// cwd tracking (parseCd / nextCwd)
// ---------------------------------------------------------------------------

describe('parseCd / nextCwd', () => {
  it('parseCd recognizes cd and pushd, ignores other commands', () => {
    expect(parseCd('cd scripts')).toBe('scripts');
    expect(parseCd('pushd a/b')).toBe('a/b');
    expect(parseCd('python3 x.py')).toBeNull();
    expect(parseCd('cd')).toBeNull();
  });

  it('nextCwd joins relative dirs and marks untrackable ones null', () => {
    expect(nextCwd('', 'scripts')).toBe('scripts');
    expect(nextCwd('scripts', 'office')).toBe('scripts/office');
    expect(nextCwd('scripts/office', '..')).toBe('scripts');
    expect(nextCwd('', '$DIR')).toBeNull();
    expect(nextCwd('', '/abs')).toBeNull();
    expect(nextCwd('', '~')).toBeNull();
    expect(nextCwd('', '-')).toBeNull();
    expect(nextCwd('', '..')).toBeNull();
    expect(nextCwd(null, 'scripts')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// command-exists
// ---------------------------------------------------------------------------

describe('commandExists', () => {
  it('flags a `run` invocation of a missing script as error/high from a fence', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npnpm run deploy\n```\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('command-exists');
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toContain('"deploy"');
    expect(f.message).toContain('does not exist in package.json');
    expect(f.location).toEqual({ file: 'CLAUDE.md', line: 2 });
  });

  it('accepts existing scripts and existing files', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      '```bash\npnpm run build\nnpm test\nnode src/index.ts\n```\n',
    );
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toEqual([]);
  });

  it('flags bare `pnpm test` when there is no test script', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npnpm test\n```\n');
    const findings = await commandExists.run(
      makeCtx([doc], {
        packageJson: { name: 'x', scripts: { build: 'tsc' } },
        packageScripts: new Set(['build']),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('"test"');
  });

  it('warns on pnpm shorthand for a name that is neither builtin nor a script', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npnpm deploy\npnpm install\npnpm build\n```\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.confidence).toBe('medium');
    expect(findings[0]!.message).toContain('deploy');
  });

  it('flags a file-running command whose path does not exist', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npython3 scripts/gone.py\n```\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.confidence).toBe('high');
    expect(findings[0]!.message).toContain('scripts/gone.py');
    expect(findings[0]!.message).toContain('does not exist');
  });

  it('detects case mismatches and suggests the real path', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Run `python scripts/sync.py` daily.\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.suggestion).toContain('scripts/Sync.py');
  });

  it('uses medium confidence for inline (non-fence) commands', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Use `npm run lint` for linting.\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe('medium');
  });

  it('skips script checks without package.json but still checks files', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\nnpm run anything\nbash scripts/nope.sh\n```\n');
    const findings = await commandExists.run(
      makeCtx([doc], { packageJson: null, packageScripts: new Set() }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('scripts/nope.sh');
  });

  it('ignores paths with globs or shell substitutions', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\nnode dist/*.js\npython3 $SCRIPT/run.py\n```\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toEqual([]);
  });

  it('resolves file paths relative to the doc directory too', async () => {
    const doc = parseMarkdown(
      '.claude/skills/docx/SKILL.md',
      '```bash\npython scripts/office/unpack.py input.docx\n```\n',
    );
    const findings = await commandExists.run(
      makeCtx([doc], {
        files: new Set([
          '.claude/skills/docx/SKILL.md',
          '.claude/skills/docx/scripts/office/unpack.py',
        ]),
      }),
    );
    expect(findings).toEqual([]);
  });

  it('skips placeholder tokens in file-running commands', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      '```bash\npython scripts/<name>.py\nbash backups/YYYY-MM-DD.sh\nnode ~/tools/run.js\n```\n',
    );
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toEqual([]);
  });

  it('skips flag tokens after `run` and validates the first non-flag token', async () => {
    const ok = parseMarkdown('CLAUDE.md', '```bash\nnpm run --workspace=api build\n```\n');
    expect(await commandExists.run(makeCtx([ok]))).toEqual([]);

    const bad = parseMarkdown('CLAUDE.md', '```bash\nnpm run --workspace=api missing\n```\n');
    const findings = await commandExists.run(makeCtx([bad]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('"missing"');
    expect(findings[0]!.message).not.toContain('"--workspace"');
  });

  it('reports nothing for a run invocation with only flags', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npnpm run --silent\n```\n');
    expect(await commandExists.run(makeCtx([doc]))).toEqual([]);
  });

  it('reports nothing when the run script name is not a plausible token', async () => {
    // `run` with a non-script-shaped first argument: parseRunScript bails
    // rather than blaming a script that was never named.
    const doc = parseMarkdown('CLAUDE.md', "```bash\nnpm run 'my task'\n```\n");
    expect(await commandExists.run(makeCtx([doc]))).toEqual([]);
  });

  it('does not treat `yarn start` as a missing lifecycle script', async () => {
    // yarn resolves `yarn start` to `yarn run start`; the lifecycle rule
    // deliberately excludes it so a documented `yarn start` never false-fails.
    const doc = parseMarkdown('CLAUDE.md', '```bash\nyarn start\n```\n');
    const findings = await commandExists.run(
      makeCtx([doc], {
        packageJson: { name: 'x', scripts: { build: 'tsc' } },
        packageScripts: new Set(['build']),
      }),
    );
    expect(findings).toEqual([]);
  });

  it('still flags `npm start` when there is no start script', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\nnpm start\n```\n');
    const findings = await commandExists.run(
      makeCtx([doc], {
        packageJson: { name: 'x', scripts: { build: 'tsc' } },
        packageScripts: new Set(['build']),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('"start"');
  });

  it('validates a script split across a backslash continuation', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npnpm run \\\n  deploy\n```\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('"deploy"');
  });

  // --- C3: track `cd` / working directory inside code blocks ---------------

  it('resolves a script through a preceding `cd` on the same line', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\ncd scripts && python3 build.py\n```\n');
    const findings = await commandExists.run(
      makeCtx([doc], { files: new Set(['scripts/build.py', 'package.json']) }),
    );
    expect(findings).toEqual([]);
  });

  it('tracks `cd` across lines of the same block', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\ncd scripts\npython3 build.py\n```\n');
    const findings = await commandExists.run(
      makeCtx([doc], { files: new Set(['scripts/build.py', 'package.json']) }),
    );
    expect(findings).toEqual([]);
  });

  it('suppresses a file check when the cwd is untrackable (`cd $VAR`)', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\ncd $DIR && python3 x.py\n```\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toEqual([]);
  });

  it('still flags a missing file when there is no `cd` context', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\npython3 nope.py\n```\n');
    const findings = await commandExists.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('nope.py');
  });

  it('skips gitignored missing files but still flags tracked drift', async () => {
    const gitRoot = mkdtempSync(join(tmpdir(), 'soothsay-cmd-ignored-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: gitRoot });
      writeFileSync(join(gitRoot, '.gitignore'), 'playground/\n.venv/\n');
      const doc = parseMarkdown(
        'CLAUDE.md',
        '```bash\npython playground/run.py\nbash .venv/bin/activate.sh\nbash scripts/nope.sh\n```\n',
      );
      const findings = await commandExists.run(makeCtx([doc], { root: gitRoot }));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).toContain('scripts/nope.sh');
    } finally {
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// package-manager
// ---------------------------------------------------------------------------

describe('packageManagerConsistent', () => {
  it('flags `npm install` in a pnpm repo with a suggestion', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\nnpm install\n```\n');
    const findings = await packageManagerConsistent.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('package-manager');
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toContain('this repo uses pnpm');
    expect(f.message).toContain('package.json#packageManager');
    expect(f.suggestion).toContain('pnpm install');
  });

  it('downgrades global installs to warning/low', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\nnpm install -g typescript\n```\n');
    const findings = await packageManagerConsistent.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.confidence).toBe('low');
  });

  it('never flags npx, matching-manager, or non-mutating commands', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      '```bash\nnpx tsx src/index.ts\npnpm install\nnpm run build\n```\n',
    );
    const findings = await packageManagerConsistent.run(makeCtx([doc]));
    expect(findings).toEqual([]);
  });

  it('flags `sudo npm install` in a pnpm repo', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\nsudo npm install\n```\n');
    const findings = await packageManagerConsistent.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('npm install');
  });

  it('downgrades an inline negative example to info/low', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Never run `npm install` in this repo.\n');
    const findings = await packageManagerConsistent.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe('low');
    expect(f.message).toContain('(appears in a negative example)');
  });

  it('downgrades a fenced line preceded by a negation comment to info/low', async () => {
    const doc = parseMarkdown(
      'CLAUDE.md',
      "```bash\n# don't do this:\nnpm install\n```\n",
    );
    const findings = await packageManagerConsistent.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.confidence).toBe('low');
    expect(findings[0]!.message).toContain('(appears in a negative example)');
  });

  it('does not downgrade a plain instruction that merely mentions running it', async () => {
    const doc = parseMarkdown('CLAUDE.md', 'Run `npm install` to set up.\n');
    const findings = await packageManagerConsistent.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
  });

  it('does nothing when the repo has no declared package manager', async () => {
    const doc = parseMarkdown('CLAUDE.md', '```bash\nnpm install\n```\n');
    const findings = await packageManagerConsistent.run(
      makeCtx([doc], { packageManager: null, packageManagerSource: null }),
    );
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// frontmatter-valid
// ---------------------------------------------------------------------------

describe('frontmatterValid', () => {
  it('errors on SKILL.md missing frontmatter entirely', async () => {
    const doc = parseMarkdown('.claude/skills/foo/SKILL.md', '# Foo skill\n');
    const findings = await frontmatterValid.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.confidence).toBe('high');
    expect(findings[0]!.message).toMatch(/no frontmatter/i);
  });

  it('reports a parse error (not "no frontmatter") for malformed SKILL.md YAML', async () => {
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Triggers on: build, deploy\n---\n\n# Foo\n',
    );
    const findings = await frontmatterValid.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toMatch(/failed to parse/i);
    expect(f.message).not.toMatch(/no frontmatter/i);
    expect(f.suggestion).toBeTruthy();
  });

  it('reports a parse error (not "no frontmatter") for malformed agent-file YAML', async () => {
    const doc = parseMarkdown(
      '.claude/agents/helper.md',
      '---\nname: helper\ndescription: Triggers on: build, deploy\n---\n\nBody.\n',
    );
    const findings = await frontmatterValid.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toMatch(/failed to parse/i);
    expect(f.message).not.toMatch(/no frontmatter/i);
    expect(f.suggestion).toBeTruthy();
  });

  it('errors on SKILL.md missing description, warns on bad name format', async () => {
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      '---\nname: Bad_Name\n---\n\n# Foo\n',
    );
    const findings = await frontmatterValid.run(makeCtx([doc]));
    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('description');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.confidence).toBe('medium');
  });

  it('errors when an agent file has no frontmatter at all', async () => {
    const doc = parseMarkdown('.claude/agents/helper.md', '# Helper\n\nNo frontmatter here.\n');
    const findings = await frontmatterValid.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.confidence).toBe('high');
    expect(findings[0]!.message).toContain('agent file has no frontmatter');
  });

  it('warns when a skill description exceeds the 1024-char maximum', async () => {
    const long = 'x'.repeat(1025);
    const doc = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      `---\nname: foo\ndescription: ${long}\n---\n\n# Foo\n`,
    );
    const findings = await frontmatterValid.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.confidence).toBe('medium');
    expect(findings[0]!.message).toContain('1025 chars');
  });

  it('is silent for a fully valid SKILL.md and a fully valid agent file', async () => {
    const skill = parseMarkdown(
      '.claude/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Does a thing.\n---\n\n# Foo\n',
    );
    const agent = parseMarkdown(
      '.claude/agents/helper.md',
      '---\nname: helper\ndescription: Helps out.\ntools: [Read, Grep]\n---\n\nBody.\n',
    );
    const findings = await frontmatterValid.run(makeCtx([skill, agent]));
    expect(findings).toEqual([]);
  });

  it('accepts a string-valued tools key on an agent file', async () => {
    const doc = parseMarkdown(
      '.claude/agents/helper.md',
      '---\nname: helper\ndescription: Helps out.\ntools: "Read, Grep, Bash"\n---\n\nBody.\n',
    );
    const findings = await frontmatterValid.run(makeCtx([doc]));
    expect(findings).toEqual([]);
  });

  it('errors when an agent file has a non-string, non-string-array tools key', async () => {
    const doc = parseMarkdown(
      '.claude/agents/helper.md',
      '---\nname: helper\ndescription: Helps out.\ntools: 42\n---\n\nBody.\n',
    );
    const findings = await frontmatterValid.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.confidence).toBe('high');
    expect(findings[0]!.message).toContain('tools');
  });

  it('imposes no requirements on other docs', async () => {
    const plain = parseMarkdown('CLAUDE.md', '# Rules, no frontmatter\n');
    const withFm = parseMarkdown('docs/guide.md', '---\nanything: true\n---\n\n# G\n');
    const findings = await frontmatterValid.run(makeCtx([plain, withFm]));
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tool-claim-mismatch
// ---------------------------------------------------------------------------

describe('toolClaims', () => {
  it('errors when a read-only agent has a write tool in its tools array', async () => {
    const doc = parseMarkdown(
      '.claude/agents/reviewer.md',
      '---\nname: reviewer\ndescription: Read-only code reviewer.\ntools: [Read, Grep, Edit]\n---\n\nReviews code.\n',
    );
    const findings = await toolClaims.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.check).toBe('tool-claim-mismatch');
    expect(f.severity).toBe('error');
    expect(f.confidence).toBe('high');
    expect(f.message).toContain('Edit');
    expect(f.location).toEqual({ file: '.claude/agents/reviewer.md', line: 1 });
  });

  it('handles comma-separated tools strings and reports each write tool', async () => {
    const doc = parseMarkdown(
      '.claude/agents/auditor.md',
      '---\nname: auditor\ndescription: This agent never writes files.\ntools: "Read, Write, Bash"\n---\n\nAudits.\n',
    );
    const findings = await toolClaims.run(makeCtx([doc]));
    expect(findings).toHaveLength(2);
    const tools = findings.map((f) => f.message);
    expect(tools.some((m) => m.includes('Write'))).toBe(true);
    expect(tools.some((m) => m.includes('Bash'))).toBe(true);
  });

  it('warns when a read-only claim comes with no tools restriction', async () => {
    const doc = parseMarkdown(
      '.claude/agents/scout.md',
      '---\nname: scout\ndescription: A read-only exploration agent.\n---\n\nExplores.\n',
    );
    const findings = await toolClaims.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.confidence).toBe('medium');
    expect(findings[0]!.message).toContain('inherits all tools');
  });

  it('ignores non-agent docs and agents without a read-only claim', async () => {
    const nonAgent = parseMarkdown('CLAUDE.md', 'This doc is read-only in spirit.\n');
    const writer = parseMarkdown(
      '.claude/agents/writer.md',
      '---\nname: writer\ndescription: Writes docs.\ntools: [Write, Edit]\n---\n\nWrites.\n',
    );
    const findings = await toolClaims.run(makeCtx([nonAgent, writer]));
    expect(findings).toEqual([]);
  });

  it('does not flag prose about read-only folders that is not about the agent', async () => {
    const doc = parseMarkdown(
      '.claude/agents/builder.md',
      [
        '---',
        'name: builder',
        'description: Builds dashboards and reports.',
        'tools: [Read, Edit, Write]',
        '---',
        '',
        '# Builder',
        '',
        'Folder map:',
        '',
        'dashboards/ # Aggregated views (read-only, not validated)',
      ].join('\n'),
    );
    const findings = await toolClaims.run(makeCtx([doc]));
    expect(findings).toEqual([]);
  });

  it('still flags body sentences that describe the agent itself as read-only', async () => {
    const doc = parseMarkdown(
      '.claude/agents/scout2.md',
      '---\nname: scout2\ndescription: Explores the codebase.\ntools: [Read, Edit]\n---\n\nYou are a read-only exploration scout.\n',
    );
    const findings = await toolClaims.run(makeCtx([doc]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('Edit');
  });
});
