import { describe, it, expect } from 'vitest';
import { browserOpenCommand } from '../src/report/open.js';

describe('browserOpenCommand', () => {
  it('uses `open` on macOS', () => {
    expect(browserOpenCommand('darwin')).toEqual({ cmd: 'open', args: [] });
  });

  it('uses `cmd /c start` on Windows, with an empty title placeholder', () => {
    // The empty "" is the START title arg so paths with spaces are not
    // mistaken for a window title.
    expect(browserOpenCommand('win32')).toEqual({ cmd: 'cmd', args: ['/c', 'start', ''] });
  });

  it('falls back to `xdg-open` on Linux and everything else', () => {
    expect(browserOpenCommand('linux')).toEqual({ cmd: 'xdg-open', args: [] });
    expect(browserOpenCommand('freebsd')).toEqual({ cmd: 'xdg-open', args: [] });
  });
});
