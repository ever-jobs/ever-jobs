/**
 * Codemod (Spec 1685) — the tail cluster whose `scrape()` catch returns the
 * accumulator without a reason.
 *
 * After Specs 1682-1684, 164 services remain. Clustering them by what the last
 * catch of the brace-matched `scrape()` body actually does:
 *
 *   D  126  returns the accumulator, no reason   <- this codemod
 *   B   30  falls through to a later return
 *   A    5  no catch at all: the throw escapes to the fan-out, whose `rejected`
 *           branch already calls classifyScrapeError - these are CORRECT as-is
 *   C/F   3  ambiguous, hand review
 *
 * Cluster D is the shape `source-ats-smartrecruiters` had before Spec 1680
 * fixed it by hand: partial results returned with no signal at all, so a
 * page-2 failure is indistinguishable from a complete board. With Spec 1680's
 * `partial` inference, `jobs.length > 0` plus a diagnostic now reports
 * `partial` rather than `ok`.
 *
 *     return new JobResponseDto(jobPosts);
 *  -> return new JobResponseDto(jobPosts, classifyScrapeError(err));
 *
 * Safety follows Spec 1684: the return is proved to sit INSIDE the catch by
 * brace matching, never by a regex spanning from `catch (…) {`, and a
 * postcondition re-derives that from the OUTPUT. A spanning regex previously
 * rewrote a method-level return in `source-ats-loxo` where `err` was out of
 * scope — it parsed fine and only `tsc` caught it.
 *
 * Usage:
 *   ts-node scripts/codemod/tail-accumulator-catch-diagnostics.ts --expect=<n>
 *   ts-node scripts/codemod/tail-accumulator-catch-diagnostics.ts --expect=<n> --apply
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const PLUGINS_DIR = path.join(process.cwd(), 'packages', 'plugins');
const MODELS_IMPORT = /import \{\n([\s\S]*?)\n\} from '@ever-jobs\/models';/;

interface FileResult {
  file: string;
  status: 'TRANSFORMED' | 'SKIPPED' | 'CORRUPT';
  reason?: string;
}

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

/**
 * Catches binding `err` whose own block returns `new JobResponseDto(<expr>)`
 * with a single argument that is NOT a bare `[]`. Positions are relative to the
 * scrape body.
 */
function accumulatorCatches(
  body: string,
): Array<{ start: number; end: number; indent: string; arg: string }> {
  const out: Array<{ start: number; end: number; indent: string; arg: string }> = [];
  const re = /\} catch \((err|error|e)(?::\s*any)?\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== 'err') continue;
    const openIdx = body.indexOf('{', m.index + m[0].length - 1);
    const closeIdx = blockEnd(body, openIdx);
    if (closeIdx === null) continue;
    const inner = body.slice(openIdx, closeIdx);
    // Single-argument DTO return on one line, tolerating a trailing comment
    // (`return new JobResponseDto(jobPosts); // partial results` is the common
    // shape) and a call expression such as `jobPosts.slice(0, resultsWanted)`.
    const rm = /^([ \t]*)return new JobResponseDto\((.+)\);([ \t]*\/\/[^\n]*)?$/m.exec(inner);
    if (!rm) continue;
    const arg = rm[2];
    // Reject anything that is not ONE balanced argument: a top-level comma would
    // mean a second argument already exists, and unbalanced parens mean the line
    // was mis-sliced.
    let depth = 0;
    let topLevelComma = false;
    for (const ch of arg) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) topLevelComma = true;
    }
    if (depth !== 0 || topLevelComma || arg.trim() === '' || arg.trim() === '[]') continue;
    const start = openIdx + rm.index;
    out.push({ start, end: start + rm[0].length, indent: rm[1], arg });
  }
  return out;
}

function processFile(file: string, apply: boolean): FileResult {
  const buf = fs.readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const rawText = buf.toString('utf8');
  const bodyText = hasBom ? rawText.slice(1) : rawText;
  const isCrlf = bodyText.includes('\r\n');
  const text = bodyText.split('\r\n').join('\n');

  if (/classifyScrapeError|ScrapeDiagnostics/.test(text)) {
    return { file, status: 'SKIPPED', reason: 'ALREADY_MIGRATED' };
  }

  const sb = scrapeBody(text);
  if (!sb) return { file, status: 'SKIPPED', reason: 'NO_SCRAPE_BODY' };

  const hits = accumulatorCatches(sb.body);
  if (hits.length === 0) return { file, status: 'SKIPPED', reason: 'NO_ANCHOR' };
  if (hits.length > 1) return { file, status: 'SKIPPED', reason: 'MULTI_ANCHOR' };

  const imp = text.match(MODELS_IMPORT);
  if (!imp || !imp[1].includes('JobResponseDto')) {
    return { file, status: 'SKIPPED', reason: 'IMPORT_SHAPE' };
  }

  const hit = hits[0];
  const newBody =
    sb.body.slice(0, hit.start) +
    `${hit.indent}// Partial results WITH a reason: jobs.length > 0 plus a diagnostic is\n` +
    `${hit.indent}// inferred as 'partial' upstream, so a mid-scrape failure is no longer\n` +
    `${hit.indent}// indistinguishable from a complete board.\n` +
    `${hit.indent}return new JobResponseDto(${hit.arg}, classifyScrapeError(err));` +
    sb.body.slice(hit.end);

  let out = text.slice(0, sb.start) + newBody + text.slice(sb.start + sb.body.length);
  out = out.replace(MODELS_IMPORT, (m) =>
    m.replace('import {\n', 'import {\n  classifyScrapeError,\n'),
  );

  // --- postconditions ------------------------------------------------------
  const parsed = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true);
  const parseErrors = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) return { file, status: 'CORRUPT', reason: 'parse diagnostics' };
  if ((out.match(/classifyScrapeError\(err\)/g) ?? []).length !== 1) {
    return { file, status: 'CORRUPT', reason: 'expected exactly one call' };
  }
  if (out.split('\n').length - text.split('\n').length !== 4) {
    return { file, status: 'CORRUPT', reason: 'unexpected line delta' };
  }
  // Re-derive scope from the OUTPUT (the Spec 1684 lesson).
  {
    const sb2 = scrapeBody(out);
    if (!sb2) return { file, status: 'CORRUPT', reason: 'scrape body lost' };
    const re = /\} catch \(err(?::\s*any)?\) \{/g;
    let inside = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sb2.body)) !== null) {
      const openIdx = sb2.body.indexOf('{', m.index + m[0].length - 1);
      const closeIdx = blockEnd(sb2.body, openIdx);
      if (closeIdx === null) continue;
      if (sb2.body.slice(openIdx, closeIdx).includes('classifyScrapeError(err)')) {
        inside = true;
        break;
      }
    }
    if (!inside) return { file, status: 'CORRUPT', reason: 'call not inside an err catch' };
  }

  if (apply) {
    const restored = isCrlf ? out.split('\n').join('\r\n') : out;
    fs.writeFileSync(file, Buffer.concat([
      hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
      Buffer.from(restored, 'utf8'),
    ]));
  }
  return { file, status: 'TRANSFORMED' };
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const expectArg = args.find((a) => a.startsWith('--expect='));
  if (!expectArg) {
    console.error('--expect=<n> is required.');
    process.exit(2);
  }
  const expect = Number(expectArg.split('=')[1]);

  const files: string[] = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    if (!dir.startsWith('source-')) continue;
    const srcDir = path.join(PLUGINS_DIR, dir, 'src');
    if (!fs.existsSync(srcDir)) continue;
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith('.service.ts')) files.push(path.join(srcDir, f));
    }
  }

  const results = files.sort().map((f) => processFile(f, apply));
  const transformed = results.filter((r) => r.status === 'TRANSFORMED');
  const corrupt = results.filter((r) => r.status === 'CORRUPT');
  const skipped = results.filter((r) => r.status === 'SKIPPED');

  const byReason: Record<string, number> = {};
  for (const s of skipped) byReason[s.reason!] = (byReason[s.reason!] ?? 0) + 1;

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: transformed=${transformed.length} skipped=${skipped.length} corrupt=${corrupt.length}`);
  console.log('  skip reasons:', JSON.stringify(byReason));
  for (const c of corrupt) console.error(`  CORRUPT ${c.file}: ${c.reason}`);

  const allowed = new Set([
    'ALREADY_MIGRATED', 'NO_ANCHOR', 'NO_SCRAPE_BODY', 'MULTI_ANCHOR', 'IMPORT_SHAPE',
  ]);
  const unexpected = skipped.filter((s) => !allowed.has(s.reason!));
  for (const u of unexpected) console.error(`  UNEXPECTED SKIP ${u.file}: ${u.reason}`);

  if (corrupt.length > 0) { console.error('FAIL: corrupt files'); process.exit(2); }
  if (unexpected.length > 0) { console.error('FAIL: unexpected skips'); process.exit(2); }
  if (transformed.length !== expect) {
    console.error(`FAIL: expected ${expect}, transformed ${transformed.length}`);
    process.exit(2);
  }
  console.log('OK');
}

main();
