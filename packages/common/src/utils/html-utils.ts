/**
 * HTML utility functions for ATS scrapers that return HTML descriptions.
 */

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&#x2F;': '/',
  '&#x27;': "'",
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&bull;': '•',
  '&lsquo;': '\u2018',
  '&rsquo;': '\u2019',
  '&ldquo;': '\u201C',
  '&rdquo;': '\u201D',
};

/**
 * Decode common HTML entities in a string.
 */
export function decodeHtmlEntities(html: string): string {
  let result = html;
  for (const [entity, char] of Object.entries(HTML_ENTITY_MAP)) {
    result = result.replace(new RegExp(entity, 'gi'), char);
  }
  // Handle numeric entities (&#123; and &#x1A;)
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

/**
 * Strip all HTML tags from a string, returning raw text.
 */
export function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Convert Markdown to plain text: headings, emphasis, inline code, block
 * quotes and horizontal rules lose their markers, links and images keep their
 * text, list items keep a "- " bullet. HTML embedded in the Markdown is
 * converted with {@link htmlToPlainText}. Never throws.
 */
export function markdownToPlainText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images -> alt text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links -> link text
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ''); // ATX headings
  text = text.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, ''); // horizontal rules
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, ''); // block quotes
  text = text.replace(/^([ \t]*)[*+-][ \t]+/gm, '$1- '); // list bullets
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2'); // strong
  text = text.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2'); // *em*
  text = text.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2'); // _em_
  text = text.replace(/`([^`\n]+)`/g, '$1'); // inline code
  if (/<[a-z/!][^>]*>/i.test(text)) text = htmlToPlainText(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert HTML to clean plain text.
 * Handles block elements (p, div, br, li, h1-h6) with line breaks,
 * strips remaining tags, decodes entities, and normalizes whitespace.
 */
export function htmlToPlainText(html: string): string {
  let text = html;

  // Replace <br> variants with newline
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Replace block-level closing tags with newline
  text = text.replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article|header|footer)>/gi, '\n');

  // Replace <li> opening tags with bullet point
  text = text.replace(/<li[^>]*>/gi, '• ');

  // Strip all remaining HTML tags
  text = stripHtmlTags(text);

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace: collapse runs of spaces/tabs on same line
  text = text.replace(/[ \t]+/g, ' ');

  // Collapse more than 2 consecutive newlines into 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace from each line
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  return text;
}
