import { describe, it, expect } from 'vitest';
import { renderGithub, renderHtml, renderJson, renderTty } from '../src/report/render.js';
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

describe('renderHtml', () => {
  it('emits a self-contained HTML document with inline styles and no external refs', () => {
    const html = renderHtml([finding({})], verdict([finding({})]));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
    // Lightweight + offline: nothing loaded from the network.
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('groups findings by file and shows message, check, line and suggestion', () => {
    const fs = [
      finding({ message: 'missing target', suggestion: 'restore docs/gone.md' }),
      finding({ location: { file: 'b.md', line: 7 }, check: 'link-valid' }),
    ];
    const html = renderHtml(fs, verdict(fs));
    expect(html).toContain('CLAUDE.md');
    expect(html).toContain('b.md');
    expect(html).toContain('missing target');
    expect(html).toContain('restore docs/gone.md');
    expect(html).toContain('path-exists');
    expect(html).toContain('link-valid');
    expect(html).toContain('7');
  });

  it('states the verdict and the severity tallies', () => {
    const fs = [finding({}), finding({ severity: 'warning', confidence: 'low' })];
    const html = renderHtml(fs, verdict(fs));
    expect(html).toContain('FAIL');
    const clean = renderHtml([], verdict([]));
    expect(clean).toContain('PASS');
    expect(clean).toContain('no findings');
  });

  it('escapes HTML in every field so a doc cannot inject markup', () => {
    const html = renderHtml(
      [
        finding({
          message: '<script>alert(1)</script>',
          suggestion: 'use <b>bold</b> & "quotes"',
          location: { file: '<img src=x>.md', line: 1 },
        }),
      ],
      verdict([]),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('shows lower-than-high confidence and an applied-autofix note', () => {
    const fs = [finding({ confidence: 'medium' })];
    const html = renderHtml(fs, verdict(fs), 3);
    expect(html).toContain('medium');
    expect(html).toContain('3');
  });
});
