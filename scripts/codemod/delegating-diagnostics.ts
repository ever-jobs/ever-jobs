/**
 * Codemod (Spec 1682) — report a registry miss as `not_registered`.
 *
 * The 699 `source-company-*` delegating plugins carry no scraping logic: they
 * resolve a backend ATS scraper from the registry and return its result
 * verbatim. Their one independent failure path is the registry miss, and it
 * emitted a bare `new JobResponseDto([])`, which upstream is indistinguishable
 * from a board that genuinely had no postings — even though no request was ever
 * made. Spec 1680 added `not_registered` for exactly this.
 *
 * WHY A VALIDATING TRANSFORM RATHER THAN A REGEX SWEEP
 *
 * Silently mis-transforming a subset of 699 files is a far worse outcome than
 * transforming none, so every file passes a precondition gate before editing and
 * a postcondition gate before writing. Anything not understood is SKIPPED and
 * reported, never partially edited. The run fails loudly unless the transformed
 * count matches `--expect` exactly.
 *
 * An AST printer was rejected deliberately: ts-morph reprints the whole file,
 * normalising formatting across 699 files and burying two real edits in
 * thousands of cosmetic lines. The TypeScript parser is still used — as a
 * *verifier* (Q1), not a printer — which gives AST-grade safety with a
 * reviewable diff.
 *
 * LINE ENDINGS ARE LOAD-BEARING. The tree is mixed: 293 CRLF files and 154 with
 * a BOM, with no `.gitattributes`. Git Bash strips CR in text mode, which is how
 * that went unnoticed. Files are read as bytes, normalised in memory only, and
 * written back with their original EOL and BOM restored.
 *
 * Usage:
 *   ts-node scripts/codemod/delegating-diagnostics.ts --expect=699            # dry run
 *   ts-node scripts/codemod/delegating-diagnostics.ts --expect=699 --apply
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const PLUGINS_DIR = path.join(process.cwd(), 'packages', 'plugins');

type SkipReason =
  | 'NOT_DELEGATING'
  | 'ALREADY_MIGRATED'
  | 'NO_ANCHOR'
  | 'MULTI_ANCHOR'
  | 'IMPORT_SHAPE'
  | 'NO_BACKEND_LABEL';

interface FileResult {
  file: string;
  status: 'TRANSFORMED' | 'SKIPPED' | 'CORRUPT';
  reason?: SkipReason;
  detail?: string;
}

/** The registry-miss return, as emitted by all five delegating scaffolders. */
const ANCHOR = /^([ \t]*)return new JobResponseDto\(\[\]\);$/m;

/**
 * The backend's display label, taken from the logger line immediately above the
 * anchor: `'<Label> source plugin is not registered; cannot scrape <Company>'`.
 * Derived rather than hard-coded so a new backend needs no codemod change.
 */
const BACKEND_LABEL = /'([A-Za-z][A-Za-z0-9 ]*) source plugin is not registered/;

function listServiceFiles(): string[] {
  const out: string[] = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    if (!dir.startsWith('source-company-')) continue;
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
  const text = body.split('\r\n').join('\n'); // normalise IN MEMORY ONLY

  if (!/registry\?\.getScraper\(/.test(text)) {
    return { file, status: 'SKIPPED', reason: 'NOT_DELEGATING' };
  }
  if (/ScrapeDiagnostics/.test(text)) {
    return { file, status: 'SKIPPED', reason: 'ALREADY_MIGRATED' };
  }

  const anchorMatches = text.match(new RegExp(ANCHOR.source, 'gm')) ?? [];
  if (anchorMatches.length === 0) return { file, status: 'SKIPPED', reason: 'NO_ANCHOR' };
  if (anchorMatches.length > 1) return { file, status: 'SKIPPED', reason: 'MULTI_ANCHOR' };

  const labelMatch = text.match(BACKEND_LABEL);
  if (!labelMatch) return { file, status: 'SKIPPED', reason: 'NO_BACKEND_LABEL' };
  const label = labelMatch[1];

  const importAnchor = '  IScraper, ScraperInputDto, JobResponseDto, Site,\n';
  if (!text.includes(importAnchor)) return { file, status: 'SKIPPED', reason: 'IMPORT_SHAPE' };

  // --- transform. Replacement FUNCTIONS, never strings: the workspace foot-gun
  // is that `$'`/`$&` in a string replacement get expanded by JS.
  let out = text.replace(importAnchor, () => importAnchor + '  ScrapeDiagnostics,\n');
  out = out.replace(new RegExp(ANCHOR.source, 'm'), (_m, indent: string) =>
    [
      `${indent}// A registry miss is a wiring problem, not an empty board -`,
      `${indent}// not_registered keeps the two distinguishable upstream.`,
      `${indent}return new JobResponseDto(`,
      `${indent}  [],`,
      `${indent}  new ScrapeDiagnostics('not_registered', '${label} source plugin is not registered'),`,
      `${indent});`,
    ].join('\n'),
  );

  // --- postconditions: abort rather than write anything suspect
  const parsed = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true);
  const parseErrors = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) {
    return { file, status: 'CORRUPT', detail: `${parseErrors.length} parse diagnostics` };
  }
  if ((out.match(/new ScrapeDiagnostics\('not_registered'/g) ?? []).length !== 1) {
    return { file, status: 'CORRUPT', detail: 'expected exactly one not_registered' };
  }
  if (/return new JobResponseDto\(\[\]\);/.test(out)) {
    return { file, status: 'CORRUPT', detail: 'bare empty return survived' };
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
  return { file, status: 'TRANSFORMED', detail: label };
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const expectArg = args.find((a) => a.startsWith('--expect='));
  if (!expectArg) {
    console.error('--expect=<n> is required: a codemod without an expected count cannot fail loudly.');
    process.exit(2);
  }
  const expect = Number(expectArg.split('=')[1]);

  const results = listServiceFiles().map((f) => processFile(f, apply));
  const transformed = results.filter((r) => r.status === 'TRANSFORMED');
  const corrupt = results.filter((r) => r.status === 'CORRUPT');
  const skipped = results.filter((r) => r.status === 'SKIPPED');

  const byReason: Record<string, number> = {};
  for (const s of skipped) byReason[s.reason!] = (byReason[s.reason!] ?? 0) + 1;

  const byLabel: Record<string, number> = {};
  for (const t of transformed) byLabel[t.detail!] = (byLabel[t.detail!] ?? 0) + 1;

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: transformed=${transformed.length} skipped=${skipped.length} corrupt=${corrupt.length}`);
  console.log('  by backend :', JSON.stringify(byLabel));
  console.log('  skip reasons:', JSON.stringify(byReason));
  for (const c of corrupt) console.error(`  CORRUPT ${c.file}: ${c.detail}`);

  const unexpected = skipped.filter(
    (s) => s.reason !== 'NOT_DELEGATING' && s.reason !== 'ALREADY_MIGRATED',
  );
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
