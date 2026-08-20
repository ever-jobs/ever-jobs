/**
 * Assisted edit (Spec 1686) — thread a diagnostic to the terminal return.
 *
 * The remaining services' `scrape()` catch has NO return: it logs and falls
 * through to a later `return new JobResponseDto(...)`. The reason therefore has
 * to be carried in a variable — declare, assign, use.
 *
 * A fully automatic version of this was tried in Spec 1685 and abandoned: it
 * guessed the declaration point from "the first top-level try", and `tsc`
 * rejected 3 of the 6 files it accepted with `Cannot find name 'diagnostics'`.
 * The guess is the part that cannot be automated safely.
 *
 * So this tool does NOT guess. Every file supplies, from reading it:
 *   declAfter    — the exact existing line to declare after (scope decided by a human read)
 *   accumulator  — the exact argument text of the terminal return
 *   catchIndex   — which `err` catch carries the reason (-1 = last)
 *
 * The mechanical parts — locating the catch by brace matching, rewriting the
 * return, adding imports, preserving CRLF/BOM, verifying the result parses and
 * that the assignment landed inside an `err` catch — stay automated, because
 * those are exactly what hand-editing 33 files gets wrong.
 *
 * Usage: ts-node scripts/codemod/apply-fallthrough-diagnostics.ts <plan.json> [--apply]
 */
import * as fs from 'fs';
import * as ts from 'typescript';

interface PlanEntry {
  file: string;
  declAfter: string;
  accumulator: string;
  catchIndex?: number;
}

const MODELS_IMPORT = /import \{\n([\s\S]*?)\n\} from '@ever-jobs\/models';/;

function blockEnd(text: string, openIdx: number): number | null {
  let depth = 0;
  for (let j = openIdx; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return null;
}

function scrapeBody(text: string): { body: string; start: number } | null {
  const m = /async scrape\s*\([^)]*\)\s*:\s*Promise<[^>]*>\s*\{/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  const end = blockEnd(text, start);
  return end === null ? null : { body: text.slice(start, end + 1), start };
}

function apply(entry: PlanEntry, write: boolean): string {
  const buf = fs.readFileSync(entry.file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const rawText = buf.toString('utf8');
  const bodyText = hasBom ? rawText.slice(1) : rawText;
  const isCrlf = bodyText.includes('\r\n');
  const text = bodyText.split('\r\n').join('\n');

  if (/classifyScrapeError|ScrapeDiagnostics/.test(text)) return 'ALREADY_MIGRATED';

  const sb = scrapeBody(text);
  if (!sb) return 'NO_SCRAPE_BODY';
  let body = sb.body;

  // --- 3. terminal return (rewrite last, so earlier offsets stay valid) ------
  const retNeedle = `return new JobResponseDto(${entry.accumulator});`;
  const retCount = body.split(retNeedle).length - 1;
  if (retCount !== 1) return `RETURN_COUNT_${retCount}`;
  body = body.replace(
    retNeedle,
    () => `return new JobResponseDto(${entry.accumulator}, diagnostics);`,
  );

  // --- 2. assignment inside the chosen catch --------------------------------
  const catches = [...body.matchAll(/\} catch \((err)(?::\s*any)?\) \{/g)];
  if (catches.length === 0) return 'NO_ERR_CATCH';
  const idx = entry.catchIndex === undefined || entry.catchIndex < 0
    ? catches.length - 1
    : entry.catchIndex;
  if (idx >= catches.length) return 'CATCH_INDEX_OOR';
  const cm = catches[idx];
  const cOpen = body.indexOf('{', cm.index! + cm[0].length - 1);
  const cClose = blockEnd(body, cOpen);
  if (cClose === null) return 'CATCH_UNMATCHED';
  if (/\breturn\b/.test(body.slice(cOpen, cClose))) return 'CATCH_HAS_RETURN';

  const lastLine = body.slice(0, cClose).split('\n').pop() ?? '';
  const indent = /^[ \t]*/.exec(lastLine)?.[0] ?? '      ';
  body =
    body.slice(0, cClose) +
    `${indent}  diagnostics = classifyScrapeError(err);\n${indent}` +
    body.slice(cClose + (body[cClose - 1] === '\n' ? 0 : 0)).replace(/^[ \t]*/, '');

  // --- 1. declaration, at the caller-specified line -------------------------
  const declCount = body.split(entry.declAfter).length - 1;
  if (declCount !== 1) return `DECL_ANCHOR_${declCount}`;
  const declIndent = /^[ \t]*/.exec(
    body.split('\n').find((l) => l.includes(entry.declAfter.trim())) ?? '    ',
  )?.[0] ?? '    ';
  body = body.replace(
    entry.declAfter,
    () => `${entry.declAfter}\n${declIndent}let diagnostics: ScrapeDiagnostics | undefined;`,
  );

  let out = text.slice(0, sb.start) + body + text.slice(sb.start + sb.body.length);
  const imp = out.match(MODELS_IMPORT);
  if (!imp) return 'IMPORT_SHAPE';
  out = out.replace(MODELS_IMPORT, (m) =>
    m.replace('import {\n', 'import {\n  classifyScrapeError,\n  ScrapeDiagnostics,\n'),
  );

  // --- verification ---------------------------------------------------------
  const parsed = ts.createSourceFile(entry.file, out, ts.ScriptTarget.Latest, true);
  const errs = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (errs.length > 0) return 'CORRUPT_PARSE';
  if ((out.match(/classifyScrapeError\(err\)/g) ?? []).length !== 1) return 'CORRUPT_CALLS';
  if ((out.match(/let diagnostics: ScrapeDiagnostics \| undefined;/g) ?? []).length !== 1) {
    return 'CORRUPT_DECL';
  }
  {
    const sb2 = scrapeBody(out);
    if (!sb2) return 'CORRUPT_BODY';
    let inside = false;
    for (const m of sb2.body.matchAll(/\} catch \(err(?::\s*any)?\) \{/g)) {
      const o = sb2.body.indexOf('{', m.index! + m[0].length - 1);
      const c = blockEnd(sb2.body, o);
      if (c !== null && sb2.body.slice(o, c).includes('classifyScrapeError(err)')) inside = true;
    }
    if (!inside) return 'CORRUPT_SCOPE';
  }

  if (write) {
    const restored = isCrlf ? out.split('\n').join('\r\n') : out;
    fs.writeFileSync(entry.file, Buffer.concat([
      hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
      Buffer.from(restored, 'utf8'),
    ]));
  }
  return 'OK';
}

const planPath = process.argv[2];
const write = process.argv.includes('--apply');
const plan: PlanEntry[] = JSON.parse(fs.readFileSync(planPath, 'utf8'));

let ok = 0;
const failures: string[] = [];
for (const e of plan) {
  const r = apply(e, write);
  if (r === 'OK') ok++;
  else failures.push(`${r}  ${e.file}`);
}
console.log(`${write ? 'APPLIED' : 'DRY RUN'}: ok=${ok}/${plan.length}`);
for (const f of failures) console.error('  ' + f);
if (failures.length > 0) process.exit(2);
