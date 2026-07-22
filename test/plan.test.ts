import { describe, it, expect } from 'vitest';
import { planHtmlReport, type ReportFlags } from '../src/report/plan.js';

const flags = (over: Partial<ReportFlags> = {}): ReportFlags => ({
  html: false,
  open: false,
  noOpen: false,
  json: false,
  github: false,
  isTty: false,
  isCI: false,
  hasFindings: true,
  ...over,
});

describe('planHtmlReport', () => {
  it('auto-writes to a temp file and opens in an interactive terminal with findings', () => {
    expect(planHtmlReport(flags({ isTty: true }))).toEqual({
      write: true,
      open: true,
      location: 'temp',
    });
  });

  it('does nothing by default when there are no findings', () => {
    expect(planHtmlReport(flags({ isTty: true, hasFindings: false }))).toEqual({
      write: false,
      open: false,
      location: 'temp',
    });
  });

  it('does not auto-open when output is piped (non-TTY)', () => {
    expect(planHtmlReport(flags({ isTty: false }))).toMatchObject({ write: false, open: false });
  });

  it('never auto-opens under CI', () => {
    expect(planHtmlReport(flags({ isTty: true, isCI: true }))).toMatchObject({
      write: false,
      open: false,
    });
  });

  it('does not auto-open in machine modes (--json / --github)', () => {
    expect(planHtmlReport(flags({ isTty: true, json: true }))).toMatchObject({ open: false });
    expect(planHtmlReport(flags({ isTty: true, github: true }))).toMatchObject({ open: false });
  });

  it('--no-open suppresses the auto-open', () => {
    expect(planHtmlReport(flags({ isTty: true, noOpen: true }))).toMatchObject({
      write: false,
      open: false,
    });
  });

  it('--html writes a persistent artifact in the project dir, without opening', () => {
    expect(planHtmlReport(flags({ html: true, isTty: false }))).toEqual({
      write: true,
      open: false,
      location: 'cwd',
    });
  });

  it('--html-file writes to the given path', () => {
    expect(planHtmlReport(flags({ htmlFile: 'out/r.html', isTty: false }))).toMatchObject({
      write: true,
      location: 'file',
    });
  });

  it('--open force-opens even when piped, but still not under CI', () => {
    expect(planHtmlReport(flags({ open: true, isTty: false }))).toMatchObject({
      write: true,
      open: true,
      location: 'temp',
    });
    expect(planHtmlReport(flags({ open: true, isTty: false, isCI: true }))).toMatchObject({
      open: false,
    });
  });

  it('--no-open with --html keeps the artifact but does not open', () => {
    expect(planHtmlReport(flags({ html: true, noOpen: true, isTty: true }))).toEqual({
      write: true,
      open: false,
      location: 'cwd',
    });
  });
});
