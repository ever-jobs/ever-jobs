/**
 * Codemod (Spec 1684) — the tail cluster whose `scrape()` catch returns a bare
 * empty result.
 *
 * After Specs 1682 and 1683 migrated the delegating and canonical-swallow
 * buckets, 264 services remain. They are NOT one shape: clustering them by the
 * catch of their brace-matched `scrape()` body — rather than "the last catch in
 * the file", which conflates outer catches with per-item and helper ones —
 * gives dozens of variants.
 *
 * This handles the single largest safe cluster: `scrape()` has exactly one
 * catch whose body returns `new JobResponseDto([])`. Those need no
 * restructuring, only the reason added:
 *
 *     return new JobResponseDto([], classifyScrapeError(err));
 *
 * WHY BRACE MATCHING RATHER THAN A SPANNING REGEX
 *
 * The first version of this used a regex running from `catch (…) {` to the
 * return. That silently crossed the catch's closing brace and rewrote a
 * METHOD-LEVEL return in `source-ats-loxo`, where `err` is out of scope. It
 * parsed fine, so the postcondition gates passed; only `tsc` caught it. The
 * return must therefore be *proved* to sit inside the catch block by matching
 * braces, not assumed from proximity.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not hoist accumulators. Many of these declare the accumulator INSIDE
 * the `try`, so it is out of scope in the catch — which is why they return `[]`
 * to begin with. Recovering their partial results is a separate change needing
 * per-file review; bundling it here would turn a mechanical pass into a risky
 * one. Reporting the reason is the goal.
 *
 * Usage:
 *   ts-node scripts/codemod/tail-empty-catch-diagnostics.ts --expect=<n>
 *   ts-node scripts/codemod/tail-empty-catch-diagnostics.ts --expect=<n> --apply
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
  detail?: string;
}

/** Brace-match a block, given the index of its opening `{`. */
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

/** Brace-match the `async scrape(...)` body so inner catches are excluded. */
function scrapeBody(text: string): { body: string; start: number } | null {
  const m = /async scrape\s*\([^)]*\)\s*:\s*Promise<[^>]*>\s*\{/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  const end = blockEnd(text, start);
  return end === null ? null : { body: text.slice(start, end + 1), start };
}

/**
 * Every `catch` block in `body` that binds `err` and whose OWN block contains a
 * bare `return new JobResponseDto([]);`. Positions are relative to `body`.
 */
function bareEmptyCatches(body: string): Array<{ retStart: number; retEnd: number; indent: string }> {
  const out: Array<{ retStart: number; retEnd: number; indent: string }> = [];
  const re = /\} catch \((err|error|e)(?::\s*any)?\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== 'err') continue; // classifyScrapeError(err) would not compile
    const openIdx = body.indexOf('{', m.index + m[0].length - 1);
    const closeIdx = blockEnd(body, openIdx);
    if (closeIdx === null) continue;
    const inner = body.slice(openIdx, closeIdx); // strictly inside the catch
    const rm = /^([ \t]*)return new JobResponseDto\(\[\]\);$/m.exec(inner);
    if (!rm) continue;
    const retStart = openIdx + rm.index;
    out.push({ retStart, retEnd: retStart + rm[0].length, indent: rm[1] });
  }
  return out;
}

function listServiceFiles(): string[] {
  const out: string[] = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    if (!dir.startsWith('source-')) continue;
    const srcDir = path.join(PLUGINS_DIR, dir, 'src');
    if (!fs.existsSync(srcDir)) continue;
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith('.service.ts')) out.push(path.join(srcDir, f));
    }
  }
  return out.sort();
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

  const hits = bareEmptyCatches(sb.body);
  if (hits.length === 0) return { file, status: 'SKIPPED', reason: 'NO_ANCHOR' };
  // More than one is ambiguous; hand review beats a guess.
  if (hits.length > 1) return { file, status: 'SKIPPED', reason: 'MULTI_ANCHOR' };

  const imp = text.match(MODELS_IMPORT);
  if (!imp || !imp[1].includes('JobResponseDto')) {
    return { file, status: 'SKIPPED', reason: 'IMPORT_SHAPE' };
  }

  const hit = hits[0];
  const newBody =
    sb.body.slice(0, hit.retStart) +
    `${hit.indent}return new JobResponseDto([], classifyScrapeError(err));` +
    sb.body.slice(hit.retEnd);

  let out = text.slice(0, sb.start) + newBody + text.slice(sb.start + sb.body.length);
  out = out.replace(MODELS_IMPORT, (m) =>
    m.replace('import {\n', 'import {\n  classifyScrapeError,\n'),
  );

  // --- postconditions ------------------------------------------------------
  const parsed = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true);
  const parseErrors = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) return { file, status: 'CORRUPT', detail: 'parse diagnostics' };
  if ((out.match(/classifyScrapeError\(err\)/g) ?? []).length !== 1) {
    return { file, status: 'CORRUPT', detail: 'expected exactly one classifyScrapeError(err)' };
  }
  if (out.split('\n').length - text.split('\n').length !== 1) {
    return { file, status: 'CORRUPT', detail: 'unexpected line delta' };
  }
  // Re-derive from the OUTPUT that the call really sits inside an `err` catch.
  // This is the check that the previous spanning-regex version lacked.
  {
    const sb2 = scrapeBody(out);
    if (!sb2) return { file, status: 'CORRUPT', detail: 'scrape body lost' };
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
    if (!inside) return { file, status: 'CORRUPT', detail: 'call not inside an err catch' };
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

  const results = listServiceFiles().map((f) => processFile(f, apply));
  const transformed = results.filter((r) => r.status === 'TRANSFORMED');
  const corrupt = results.filter((r) => r.status === 'CORRUPT');
  const skipped = results.filter((r) => r.status === 'SKIPPED');

  const byReason: Record<string, number> = {};
  for (const s of skipped) byReason[s.reason!] = (byReason[s.reason!] ?? 0) + 1;

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: transformed=${transformed.length} skipped=${skipped.length} corrupt=${corrupt.length}`);
  console.log('  skip reasons:', JSON.stringify(byReason));
  for (const c of corrupt) console.error(`  CORRUPT ${c.file}: ${c.detail}`);

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
