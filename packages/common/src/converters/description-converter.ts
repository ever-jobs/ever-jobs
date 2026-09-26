import TurndownService from 'turndown';
import * as cheerio from 'cheerio';

/**
 * Process-wide switch for the Spec 1698 Markdown fidelity rules (emphasis
 * delimiters kept on the text they wrap, one-line headings, whitespace tidy).
 * On by default; `false` / `0` / `no` / `off` restores the converter's previous
 * output. A per-call {@link MarkdownConverterOptions.edgeSafe} wins over it.
 */
export const MARKDOWN_EDGE_SAFE_ENV = 'EVER_JOBS_MARKDOWN_EDGE_SAFE';

export interface MarkdownConverterOptions {
  /**
   * `true` applies the Spec 1698 rules; `false` returns the previous output
   * (stock turndown rules, no whitespace tidy). When omitted,
   * `EVER_JOBS_MARKDOWN_EDGE_SAFE` decides, and it defaults to on.
   */
  edgeSafe?: boolean;
}

function edgeSafeEnabled(options: MarkdownConverterOptions): boolean {
  if (options.edgeSafe !== undefined) return options.edgeSafe;
  const raw = process.env[MARKDOWN_EDGE_SAFE_ENV]?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

/**
 * Block content that Markdown emphasis delimiters cannot wrap. When an inline
 * emphasis element contains one of these, the delimiters are dropped rather
 * than emitted as literal asterisks around a list or heading.
 */
const BLOCK_INSIDE_INLINE = 'ul,ol,table,pre,blockquote,h1,h2,h3,h4,h5,h6,hr';

// The character class `\u200B-\u200D\u2060\uFEFF` below is the zero-width
// format characters (ZWSP, ZWNJ, ZWJ, word joiner, BOM) that rich-text editors
// put on otherwise empty lines. `\s` covers the BOM but not the others.

/**
 * A blank line ends a CommonMark paragraph, and emphasis cannot cross one. A
 * line holding only spaces, tabs or zero-width characters counts, because
 * {@link tidyMarkdown} empties those lines afterwards.
 */
const PARAGRAPH_BREAK = /(\n[ \t\u200B-\u200D\u2060\uFEFF]*\n(?:[ \t\u200B-\u200D\u2060\uFEFF]*\n)*)/;

/** Edge padding: whitespace (NBSP and `"  \n"` hard breaks included) and zero-width characters. */
const LEADING_PAD = /^[\s\u200B-\u200D\u2060\uFEFF]*/;
const PAD_CHAR = /[\s\u200B-\u200D\u2060\uFEFF]/;

/** A line holding only spaces, tabs and zero-width characters. */
const INVISIBLE_LINE = /^[ \t\u200B-\u200D\u2060\uFEFF]+$/gm;

/**
 * Index just past the last character of `text` that is not padding. A backward
 * scan, not an unanchored `[...]*$` regex: that regex is quadratic on a long
 * padding run which does not end the string (thousands of `&nbsp;` mid-text).
 */
function endOfContent(text: string, isPad: (char: string) => boolean = (char) => PAD_CHAR.test(char)): number {
  let end = text.length;
  while (end > 0 && isPad(text.charAt(end - 1))) end -= 1;
  return end;
}

/** `text` without leading or trailing padding. */
function stripPad(text: string): string {
  const body = text.slice(LEADING_PAD.exec(text)?.[0].length ?? 0);
  return body.slice(0, endOfContent(body));
}

/**
 * Wrap already-converted inline Markdown in an emphasis delimiter so that it
 * still parses as emphasis:
 *  - leading/trailing whitespace and hard breaks (`"  \n"` from `<br>`) are
 *    emitted outside the delimiters, because CommonMark refuses a delimiter
 *    run that is followed (opening) or preceded (closing) by whitespace;
 *  - content spanning a blank line is wrapped per paragraph, because emphasis
 *    cannot cross a paragraph break;
 *  - content that is only whitespace keeps its line break (if it had one)
 *    and loses the delimiters.
 */
export function wrapInlineEmphasis(content: string, delimiter: string): string {
  return content
    .split(PARAGRAPH_BREAK)
    .map((part, index) => {
      if (index % 2 === 1) return part; // the blank-line separator itself
      const leading = LEADING_PAD.exec(part)?.[0] ?? '';
      const rest = part.slice(leading.length);
      const coreEnd = endOfContent(rest);
      const core = rest.slice(0, coreEnd);
      const trailing = rest.slice(coreEnd);
      if (!core) return part.includes('\n') ? part : '';
      return `${leading}${delimiter}${core}${delimiter}${trailing}`;
    })
    .join('');
}

/**
 * True when a turndown node has a block descendant emphasis cannot wrap. The
 * node is typed structurally: the repo compiles without the DOM lib.
 */
function hasBlockDescendant(node: unknown): boolean {
  const el = node as { querySelector?: (selector: string) => unknown };
  return typeof el.querySelector === 'function' && el.querySelector(BLOCK_INSIDE_INLINE) != null;
}

/**
 * A turndown service whose emphasis and heading rules survive `<br>` at the
 * edges of the element. `addRule` puts a rule ahead of the built-in ones, so
 * these replace the stock `strong`, `emphasis` and `heading` rules; every other
 * rule and option is turndown's default.
 */
function createEdgeSafeTurndownService(): TurndownService {
  const service = new TurndownService();
  service.addRule('strongEdgeSafe', {
    filter: ['strong', 'b'],
    replacement: (content, node, options) =>
      hasBlockDescendant(node) ? content : wrapInlineEmphasis(content, options.strongDelimiter ?? '**'),
  });
  service.addRule('emphasisEdgeSafe', {
    filter: ['em', 'i'],
    replacement: (content, node, options) =>
      hasBlockDescendant(node) ? content : wrapInlineEmphasis(content, options.emDelimiter ?? '_'),
  });
  service.addRule('headingEdgeSafe', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node, options) => {
      // A Markdown heading is one line: drop edge breaks and blank lines, fold
      // the remaining lines into one, separated by a single space.
      const text = content.split('\n').map(stripPad).filter(Boolean).join(' ');
      if (!text) return '';
      const level = Number(node.nodeName.charAt(1));
      if (options.headingStyle === 'setext' && level < 3) {
        const underline = (level === 1 ? '=' : '-').repeat(text.length);
        return `\n\n${text}\n${underline}\n\n`;
      }
      return `\n\n${'#'.repeat(level)} ${text}\n\n`;
    },
  });
  return service;
}

/** Stock turndown: the converter's output before Spec 1698 (`edgeSafe: false`). */
const turndownService = new TurndownService();

/** Turndown with the Spec 1698 emphasis and heading rules (the default). */
const edgeSafeTurndownService = createEdgeSafeTurndownService();

/**
 * Remove the whitespace noise consecutive `<br>` and spacer `<div><br></div>`
 * leave behind, without changing how the Markdown renders: whitespace-only
 * lines become empty, hard-break spaces before a blank line go, and 3+
 * newlines collapse to a single blank line. Skipped when the source has
 * `<pre>`, whose blank lines are content. Line-by-line so every step stays
 * linear in the length of the document.
 */
function tidyMarkdown(markdown: string, html: string): string {
  if (/<pre[\s>]/i.test(html)) return markdown;
  const lines = markdown.replace(INVISIBLE_LINE, '').split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (lines[i + 1] === '') {
      lines[i] = lines[i].slice(0, endOfContent(lines[i], (char) => char === ' ' || char === '\t'));
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Convert HTML description to markdown.
 * Replaces Python's markdownify(description_html).
 *
 * Spec 1698: emphasis delimiters stay on the text they wrap (edge `<br>` and
 * whitespace go outside them), headings stay on one line, and runs of blank
 * or whitespace-only lines collapse. `options.edgeSafe: false` (or
 * `EVER_JOBS_MARKDOWN_EDGE_SAFE=false`) returns the previous output.
 */
export function markdownConverter(
  descriptionHtml: string | null,
  options: MarkdownConverterOptions = {},
): string | null {
  if (!descriptionHtml) return null;
  if (!edgeSafeEnabled(options)) return turndownService.turndown(descriptionHtml).trim();
  return tidyMarkdown(edgeSafeTurndownService.turndown(descriptionHtml), descriptionHtml).trim();
}

/**
 * Convert HTML description to plain text.
 * Replaces Python's plain_converter using BeautifulSoup.
 */
export function plainConverter(descriptionHtml: string | null): string | null {
  if (!descriptionHtml) return null;
  const $ = cheerio.load(descriptionHtml);
  const text = $.text();
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Remove all attributes from an HTML element (keep structure, strip attrs).
 * Replaces Python's remove_attributes(tag).
 */
export function removeAttributes(html: string): string {
  const $ = cheerio.load(html, { xmlMode: false });
  $('*').each(function () {
    const el = $(this);
    const attribs = (this as any).attribs;
    if (attribs) {
      for (const attr of Object.keys(attribs)) {
        el.removeAttr(attr);
      }
    }
  });
  return $.html();
}
