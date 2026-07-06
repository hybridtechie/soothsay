import { describe, it, expect } from 'vitest';
import { renderGithub, renderJson, renderTty } from '../src/report/render.js';
import { verdict } from '../src/engine.js';
import type { Finding } from '../src/types.js';

const finding = (over: Partial<Finding>): Finding => ({
  check: 'path-exists',
  severity: 'error',
  confidence: 'high',
  message: 'x',
  location: { file: 'CLAUDE.md', line: 3 },
  ...over,
});

describe('renderGithub', () => {
  it('maps severities to annotation levels', () => {
    const out = renderGithub([
      finding({ severity: 'error' }),
      finding({ severity: 'warning' }),
      finding({ severity: 'info' }),
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^::error /);
    expect(lines[1]).toMatch(/^::warning /);
    expect(lines[2]).toMatch(/^::notice /);
  });

  it('emits file, line and title properties', () => {
    const out = renderGithub([finding({})]);
    expect(out).toContain('file=CLAUDE.md,line=3,title=soothsay path-exists::');
  });

  it('escapes %, CR and LF in message data — % first', () => {
    const out = renderGithub([
      finding({ message: 'use `%s` here\r\nsecond line', suggestion: '50% better' }),
    ]);
    expect(out.split('\n')).toHaveLength(1); // still a single annotation line
    expect(out).toContain('use `%25s` here%0D%0Asecond line');
    expect(out).toContain('50%25 better');
    // no double-escaping of the escapes themselves
    expect(out).not.toContain('%2525');
  });

  it('sanitizes injected characters in file and check-name properties', () => {
    const out = renderGithub([
      finding({
        check: 'evil:check',
        location: { file: 'a,b:c\nd.md', line: 3 },
      }),
    ]);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('file=a_b_c_d.md,line=3,title=soothsay evil_check::');
  });
});

describe('renderJson / renderTty', () => {
  it('renderJson round-trips findings and summary', () => {
    const fs = [finding({}), finding({ severity: 'warning', confidence: 'low' })];
    const parsed = JSON.parse(renderJson(fs, verdict(fs)));
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.summary).toEqual({ errors: 1, warnings: 1, infos: 0, failed: true });
  });

  it('renderTty groups by file, shows suggestions, and states the verdict', () => {
    const fs = [
      finding({ suggestion: 'do the thing' }),
      finding({ location: { file: 'b.md', line: 1 }, severity: 'info', confidence: 'low' }),
    ];
    const out = renderTty(fs, verdict(fs));
    expect(out).toContain('CLAUDE.md');
    expect(out).toContain('b.md');
    expect(out).toContain('do the thing');
    expect(out).toContain('FAIL');
  });

  it('renderTty reports a clean pass', () => {
    expect(renderTty([], verdict([]))).toContain('no findings');
  });
});
