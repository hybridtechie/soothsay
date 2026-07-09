import YAML from 'yaml';
import type {
  CodeBlock,
  DocFile,
  Heading,
  HtmlComment,
  InlineCode,
  MdLink,
} from '../types.js';

/** GitHub-style heading slug (lowercase, punctuation stripped, spaces to -). */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
/** Setext underline: a line of only = (h1) or 2+ - (h2). */
const SETEXT_RE = /^ {0,3}(=+|-{2,})\s*$/;
/** List items and blockquotes are never promoted to setext headings. */
const LIST_OR_QUOTE_RE = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|>)/;
/** Reference-style link definition: `[label]: target` at line start. */
const REF_DEF_RE = /^ {0,3}\[([^\]]+)\]:\s+(\S+)/;
/** Reference-style link usage: `[text][label]` or `[label][]`. */
const REF_USE_RE = /\[([^\]]*)\]\[([^\]]*)\]/g;

/**
 * Extract inline links from a line, tolerating one level of balanced parens
 * in the href (`[t](docs/foo(1).md)`), angle-bracket hrefs with spaces, and
 * optional "title" strings. Appends to `out`.
 */
function extractInlineLinks(text: string, line: number, out: MdLink[]): void {
  const openRe = /\[([^\]]*)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text)) !== null) {
    const label = m[1]!;
    let i = openRe.lastIndex;
    let href: string;
    if (text[i] === '<') {
      const close = text.indexOf('>', i + 1);
      if (close < 0) continue;
      href = text.slice(i + 1, close);
      i = close + 1;
    } else {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        const c = text[j]!;
        if (c === '(') {
          depth++;
          if (depth > 1) break; // more than one nesting level — bail
        } else if (c === ')') {
          if (depth === 0) break;
          depth--;
        } else if (/\s/.test(c)) {
          break;
        }
        j++;
      }
      href = text.slice(i, j);
      i = j;
    }
    // Optional whitespace + "title" before the closing paren.
    let k = i;
    while (k < text.length && /\s/.test(text[k]!)) k++;
    if (text[k] === '"') {
      const endQuote = text.indexOf('"', k + 1);
      if (endQuote < 0) continue;
      k = endQuote + 1;
    }
    if (text[k] !== ')') continue; // malformed — not a link
    if (href.length > 0) out.push({ text: label, href, line });
    openRe.lastIndex = k + 1;
  }
}

/**
 * Parse a markdown file into the pieces soothsay checks care about.
 * Line-based, dependency-free, resilient to malformed input.
 */
export function parseMarkdown(path: string, text: string): DocFile {
  const lines = text.split(/\r?\n/);

  // --- frontmatter -------------------------------------------------------
  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | undefined;
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) {
      bodyStart = close + 1;
      const raw = lines.slice(1, close).join('\n');
      try {
        const parsed = YAML.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch (err) {
        frontmatter = null;
        frontmatterError = (err as Error).message.split('\n')[0];
      }
    }
  }

  const headings: Heading[] = [];
  const codeBlocks: CodeBlock[] = [];
  const inlineCodes: InlineCode[] = [];
  const links: MdLink[] = [];
  const comments: HtmlComment[] = [];

  const slugCounts = new Map<string, number>();
  const pushHeading = (depth: number, textPart: string, line: number): void => {
    let slug = githubSlug(textPart);
    const n = slugCounts.get(slug) ?? 0;
    slugCounts.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    headings.push({ depth, text: textPart, slug, line });
  };

  // Reference-style links: definitions + usages, resolved after the loop.
  const refDefs = new Map<string, string>();
  const refUses: { text: string; label: string; line: number }[] = [];

  let fence: { char: string; len: number; lang: string; startLine: number; code: string[] } | null =
    null;
  let comment: { startLine: number; text: string[] } | null = null;
  /** Previous line's text if it is promotable to a setext heading. */
  let prevText: string | null = null;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    // --- inside a fenced code block ---------------------------------------
    if (fence) {
      const m = FENCE_RE.exec(line);
      if (m && m[2]![0] === fence.char && m[2]!.length >= fence.len && m[3]!.trim() === '') {
        codeBlocks.push({
          lang: fence.lang,
          code: fence.code.join('\n'),
          startLine: fence.startLine,
          endLine: lineNo,
        });
        fence = null;
      } else {
        fence.code.push(line);
      }
      prevText = null;
      continue;
    }

    // --- inside a multi-line html comment ----------------------------------
    if (comment) {
      const end = line.indexOf('-->');
      if (end >= 0) {
        comment.text.push(line.slice(0, end));
        comments.push({ text: comment.text.join('\n'), line: comment.startLine });
        comment = null;
      } else {
        comment.text.push(line);
      }
      prevText = null;
      continue;
    }

    // --- fence open ---------------------------------------------------------
    const fm = FENCE_RE.exec(line);
    if (fm) {
      fence = {
        char: fm[2]![0]!,
        len: fm[2]!.length,
        lang: fm[3]!.trim().split(/\s+/)[0] ?? '',
        startLine: lineNo,
        code: [],
      };
      prevText = null;
      continue;
    }

    // --- heading -------------------------------------------------------------
    const hm = HEADING_RE.exec(line);
    if (hm) {
      pushHeading(hm[1]!.length, hm[2]!, lineNo);
      prevText = null;
      continue;
    }

    // --- setext underline: promotes the previous text line to a heading -------
    const sm = SETEXT_RE.exec(line);
    if (sm) {
      if (prevText !== null) {
        pushHeading(sm[1]![0] === '=' ? 1 : 2, prevText.trim(), lineNo - 1);
      }
      // Otherwise it is a thematic break (`---` after a blank line) — skip.
      prevText = null;
      continue;
    }

    // --- reference-style link definition ---------------------------------------
    const rd = REF_DEF_RE.exec(line);
    if (rd) {
      let target = rd[2]!;
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      const label = rd[1]!.toLowerCase();
      if (!refDefs.has(label)) refDefs.set(label, target); // first definition wins
      prevText = null;
      continue;
    }

    // --- html comments (may open mid-line) -----------------------------------
    let scanned = line;
    let open = scanned.indexOf('<!--');
    while (open >= 0) {
      const end = scanned.indexOf('-->', open + 4);
      if (end >= 0) {
        comments.push({ text: scanned.slice(open + 4, end), line: lineNo });
        scanned = scanned.slice(0, open) + scanned.slice(end + 3);
        open = scanned.indexOf('<!--');
      } else {
        comment = { startLine: lineNo, text: [scanned.slice(open + 4)] };
        scanned = scanned.slice(0, open);
        break;
      }
    }

    // --- inline code ----------------------------------------------------------
    for (const m of scanned.matchAll(INLINE_CODE_RE)) {
      inlineCodes.push({ code: m[1]!, line: lineNo });
    }

    // --- links (outside inline code spans) --------------------------------------
    const withoutCode = scanned.replace(INLINE_CODE_RE, '');
    extractInlineLinks(withoutCode, lineNo, links);
    for (const m of withoutCode.matchAll(REF_USE_RE)) {
      const label = (m[2]!.length > 0 ? m[2]! : m[1]!).toLowerCase();
      refUses.push({ text: m[1]!, label, line: lineNo });
    }

    // Track whether this line can be promoted by a setext underline below it.
    const trimmed = scanned.trim();
    prevText = trimmed.length > 0 && !LIST_OR_QUOTE_RE.test(scanned) ? scanned : null;
  }

  // Resolve reference-style usages against their definitions.
  for (const use of refUses) {
    const target = refDefs.get(use.label);
    if (target !== undefined) links.push({ text: use.text, href: target, line: use.line });
  }

  // Unclosed fence at EOF: still record what we saw.
  if (fence) {
    codeBlocks.push({
      lang: fence.lang,
      code: fence.code.join('\n'),
      startLine: fence.startLine,
      endLine: lines.length,
    });
  }

  return {
    path,
    text,
    lines,
    frontmatter,
    frontmatterError,
    headings,
    codeBlocks,
    inlineCodes,
    links,
    comments,
  };
}
