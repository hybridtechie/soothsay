/**
 * Negative-example detection: "Never run `npm install`" is documentation of
 * what NOT to do, not an instruction. Checks that flag forbidden/mismatched
 * commands use this to downgrade such findings to info/low instead of
 * failing CI over a correctly-worded warning.
 */
import type { DocFile } from '../types.js';

/** Negation cue in prose, with no sentence boundary before the code span. */
const PROSE_NEG_RE = /\b(?:never|don'?t|do not|avoid|instead of|rather than|not)\b[^.!?]*$/i;

/** Comment (`#`, `//`, `<!--`) carrying a negation cue, in a code block. */
const COMMENT_NEG_RE = /(?:#|\/\/|<!--).*\b(?:never|don'?t|do not|avoid)\b/i;

/**
 * True when the command occurrence at `line` reads as a negative example:
 * - inline code: the prose on the same line before the span matches a
 *   negation cue with no sentence-ending punctuation in between;
 * - fenced code: the line itself or the immediately preceding line in the
 *   block contains a comment with a negation cue.
 */
export function isNegativeExample(doc: DocFile, line: number, cmd: string): boolean {
  for (const block of doc.codeBlocks) {
    if (line <= block.startLine || line > block.endLine) continue;
    const blockLines = block.code.split('\n');
    const idx = line - block.startLine - 1;
    const current = blockLines[idx] ?? '';
    const previous = idx > 0 ? (blockLines[idx - 1] ?? '') : '';
    return COMMENT_NEG_RE.test(current) || COMMENT_NEG_RE.test(previous);
  }

  const raw = doc.lines[line - 1] ?? '';
  const at = raw.indexOf(cmd);
  const before = at >= 0 ? raw.slice(0, at) : raw;
  return PROSE_NEG_RE.test(before);
}
