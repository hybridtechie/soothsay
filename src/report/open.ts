import { spawn } from 'node:child_process';

/**
 * The platform command that opens a file with the OS default handler. Pure and
 * testable; the file path is appended by {@link openInBrowser}.
 */
export function browserOpenCommand(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  // The empty "" is START's title argument, so a path with spaces is not
  // mistaken for the window title.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', args: [] };
}

/**
 * Fire-and-forget: open `file` in the OS default browser. Detached so the CLI
 * exits immediately, and never throws — a missing opener (headless box) is a
 * best-effort miss, not a failure. Returns false if spawning threw outright.
 */
export function openInBrowser(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const { cmd, args } = browserOpenCommand(platform);
    const child = spawn(cmd, [...args, file], { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // swallow ENOENT / spawn failures
    child.unref();
    return true;
  } catch {
    return false;
  }
}
