/**
 * Codemod (Spec 1683) — replace the canonical swallow with a real diagnostic.
 *
 * 822 plugin services end their `scrape()` like this:
 *
 *     } catch (err: any) {
 *       this.logger.error(`… scrape failed: ${err.message}`);
 *     }
 *
 *     return { jobs };
 *
 * so a 403, a DNS failure, a Cloudflare challenge and a genuinely empty board
 * all reach the API as the same thing. This is the shape Spec 1681 stopped the
 * generators emitting; this migrates the services that already exist.
 *
 * TWO DETAILS THAT DECIDE CORRECTNESS
 *
 * 1. `jobs` is passed, never `[]`. The accumulator is declared before the `try`
 *    and filled inside it, and the catch sits outside the loop — so a board that
 *    parsed 30 postings before failing returns those 30 TODAY. Emitting
 *    `JobResponseDto([], …)` would bundle silent data loss into a diagnostics
 *    fix. Precondition P4 enforces the ordering per file rather than assuming it.
 *
 * 2. The plugin keeps RESOLVING, never throwing. `CircuitBreakerService` counts
 *    failures only on rejection, so this cannot trip a breaker. Making 822
 *    plugins throw would trip breakers on any merely-403ing source within five
 *    fan-outs and overflow `MAX_SITES = 250` against 1,832 registered sites.
 *
 * Every file in this population is CRLF (16 also carry a BOM), so byte-level
 * handling is not optional: read bytes, normalise in memory only, restore the
 * original EOL and BOM on write.
 *
 * Usage:
 *   ts-node scripts/codemod/canonical-swallow-diagnostics.ts --expect=822
 *   ts-node scripts/codemod/canonical-swallow-diagnostics.ts --expect=822 --apply
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const PLUGINS_DIR = path.join(process.cwd(), 'packages', 'plugins');

/** The canonical swallow, anchored on the whole tail so a partial match cannot fire. */
const ANCHOR =
  /^([ \t]*)\} catch \(err: any\) \{\n([ \t]*)this\.logger\.error\(`[^`]*`\);\n([ \t]*)\}\n\n([ \t]*)return \{ jobs \};$/m;

/** The `@ever-jobs/models` import block, whatever its internal wrapping. */
const MODELS_IMPORT = /import \{\n([\s\S]*?)\n\} from '@ever-jobs\/models';/;

interface FileResult {
  file: string;
  status: 'TRANSFORMED' | 'SKIPPED' | 'CORRUPT';
  reason?: string;
  detail?: string;
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
  const body = hasBom ? rawText.slice(1) : rawText;
  const isCrlf = body.includes('\r\n');
  const text = body.split('\r\n').join('\n');

  if (/classifyScrapeError|ScrapeDiagnostics/.test(text)) {
    return { file, status: 'SKIPPED', reason: 'ALREADY_MIGRATED' };
  }
  if (/registry\?\.getScraper\(/.test(text)) {
    return { file, status: 'SKIPPED', reason: 'DELEGATING' };
  }

  const anchors = text.match(new RegExp(ANCHOR.source, 'gm')) ?? [];
  if (anchors.length === 0) return { file, status: 'SKIPPED', reason: 'NO_ANCHOR' };
  if (anchors.length > 1) return { file, status: 'SKIPPED', reason: 'MULTI_ANCHOR' };

  // --- preconditions -------------------------------------------------------
  const declIdx = text.indexOf('const jobs: JobPostDto[] = [];');
  if (declIdx === -1) return { file, status: 'SKIPPED', reason: 'NO_JOBS_DECL' };
  if (text.split('const jobs: JobPostDto[] = [];').length - 1 !== 1) {
    return { file, status: 'SKIPPED', reason: 'MULTI_JOBS_DECL' };
  }
  if (text.split('return { jobs };').length - 1 !== 1) {
    return { file, status: 'SKIPPED', reason: 'MULTI_RETURN' };
  }

  const tryIdx = text.search(/\n[ \t]*try \{/);
  const anchorIdx = text.search(new RegExp(ANCHOR.source, 'm'));
  // The accumulator must be declared BEFORE the try and the catch must sit
  // AFTER it: that ordering is what makes passing `jobs` non-lossy.
  if (!(declIdx < tryIdx && tryIdx < anchorIdx)) {
    return { file, status: 'SKIPPED', reason: 'ORDER' };
  }
  if (!/jobs\.push\(/.test(text.slice(tryIdx, anchorIdx))) {
    return { file, status: 'SKIPPED', reason: 'NO_ACCUMULATION' };
  }

  const imp = text.match(MODELS_IMPORT);
  if (!imp || !imp[1].includes('JobResponseDto')) {
    return { file, status: 'SKIPPED', reason: 'IMPORT_SHAPE' };
  }

  // --- transform (replacement FUNCTIONS: `$'`/`$&` in a string would expand) --
  let out = text.replace(MODELS_IMPORT, (m) =>
    m.replace('import {\n', 'import {\n  classifyScrapeError,\n'),
  );
  out = out.replace(
    new RegExp(ANCHOR.source, 'm'),
    (_m, i1: string, i2: string, i3: string, i4: string) => {
      const logger = _m.split('\n')[1];
      return [
        `${i1}} catch (err: any) {`,
        logger,
        `${i2}// Report WHY, and keep whatever was accumulated: the catch is outside`,
        `${i2}// the loop, so a board that parsed jobs before failing still returns`,
        `${i2}// them. Resolving rather than throwing is deliberate - the breaker`,
        `${i2}// counts failures only on rejection.`,
        `${i2}return new JobResponseDto(jobs, classifyScrapeError(err));`,
        `${i3}}`,
        ``,
        `${i4}return new JobResponseDto(jobs);`,
      ].join('\n');
    },
  );

  // --- postconditions ------------------------------------------------------
  const parsed = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true);
  const parseErrors = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) return { file, status: 'CORRUPT', detail: 'parse diagnostics' };
  if ((out.match(/classifyScrapeError\(err\)/g) ?? []).length !== 1) {
    return { file, status: 'CORRUPT', detail: 'expected exactly one classifyScrapeError(err)' };
  }
  if (/return \{ jobs \};/.test(out)) {
    return { file, status: 'CORRUPT', detail: 'bare object return survived' };
  }
  if ((out.match(/return new JobResponseDto\(jobs\);/g) ?? []).length !== 1) {
    return { file, status: 'CORRUPT', detail: 'expected exactly one success return' };
  }
  if (out.split('\n').length - text.split('\n').length !== 6) {
    return { file, status: 'CORRUPT', detail: 'unexpected line delta' };
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
    console.error('--expect=<n> is required: a codemod that cannot fail loudly is not safe here.');
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
  console.log('  skip reasons:', JSON.stringify(byReason, null, 0));
  for (const c of corrupt) console.error(`  CORRUPT ${c.file}: ${c.detail}`);

  // NO_ANCHOR is expected (the 268-file tail + feature plugins); anything else
  // means a file matched the shape but failed a safety precondition, which must
  // be looked at rather than silently tolerated.
  const allowed = new Set(['ALREADY_MIGRATED', 'DELEGATING', 'NO_ANCHOR']);
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
