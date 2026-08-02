import { extractText, getDocumentProxy } from 'unpdf';

/** A pdfjs text-content item carrying a glyph run and an end-of-line flag. */
interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

function isTextItem(item: unknown): item is PdfTextItem {
  return typeof item === 'object' && item !== null && 'str' in item;
}

/**
 * Extract text from a PDF, reconstructing line and paragraph breaks from
 * pdfjs's per-item `hasEOL` flags (an empty item with `hasEOL` marks a blank
 * line). This preserves the document's line structure — far more readable than
 * the space-joined blob a plain merge produces. Falls back to unpdf's merged
 * text if the structured walk yields nothing.
 */
export async function extractPdfText(
  data: Uint8Array | ArrayBuffer,
): Promise<string> {
  const pdf = await getDocumentProxy(toPlainUint8Array(data));

  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();

    const lines: string[] = [];
    let line = '';
    for (const item of content.items) {
      if (!isTextItem(item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line.replace(/\s+$/g, ''));
        line = '';
      }
    }
    if (line.trim()) lines.push(line.trim());
    pages.push(lines.join('\n'));
  }

  const structured = collapse(pages.join('\n\n'));
  if (structured) return structured;

  const merged = await extractText(pdf, { mergePages: true });
  return collapse(typeof merged.text === 'string' ? merged.text : '');
}

/**
 * Coerce input to a plain `Uint8Array`. unpdf rejects a Node `Buffer` (a
 * `Uint8Array` subclass) outright, so a Buffer is copied into a plain array.
 */
function toPlainUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data.constructor === Uint8Array ? data : new Uint8Array(data);
}

function collapse(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
