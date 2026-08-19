/**
 * Codemod (Spec 1683, pass 2) — pin the diagnostics contract in the generated
 * plugin specs whose service this PR migrated.
 *
 * The generated failure test asserts:
 *
 *     expect(result.jobs).toEqual([]);
 *     expect(mockGet).toHaveBeenCalledTimes(1);
 *
 * `result.jobs` stays `[]` whatever the plugin reports, so that assertion passed
 * before the service codemod and would pass after a botched one. It is not
 * evidence of anything. This adds the assertion that actually pins the contract.
 *
 * THE CRITICAL PRECONDITION: only migrate a spec whose SIBLING SERVICE was
 * migrated. 809 specs match the anchor but only ~806 belong to services in the
 * canonical bucket — the surplus are tail-bucket plugins that share the
 * generated shape. Asserting `fetch_error` against a service that still
 * swallows would produce a red test that looks like a real regression.
 *
 * Usage:
 *   ts-node scripts/codemod/canonical-swallow-specs.ts --expect=<n>
 *   ts-node scripts/codemod/canonical-swallow-specs.ts --expect=<n> --apply
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const PLUGINS_DIR = path.join(process.cwd(), 'packages', 'plugins');

const ANCHOR =
  /^([ \t]*)expect\(result\.jobs\)\.toEqual\(\[\]\);\n([ \t]*)expect\(mockGet\)\.toHaveBeenCalledTimes\(1\);$/m;

interface FileResult {
  file: string;
  status: 'TRANSFORMED' | 'SKIPPED' | 'CORRUPT';
  reason?: string;
  detail?: string;
}

function listSpecFiles(): string[] {
  const out: string[] = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    if (!dir.startsWith('source-')) continue;
    const testDir = path.join(PLUGINS_DIR, dir, '__tests__');
    if (!fs.existsSync(testDir)) continue;
    for (const f of fs.readdirSync(testDir)) {
      if (f.endsWith('.service.spec.ts')) out.push(path.join(testDir, f));
    }
  }
  return out.sort();
}

/** True when the sibling service carries the migrated catch from pass 1. */
function siblingServiceMigrated(specFile: string): boolean {
  const srcDir = path.join(path.dirname(path.dirname(specFile)), 'src');
  if (!fs.existsSync(srcDir)) return false;
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.service.ts')) continue;
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    if (text.includes('return new JobResponseDto(jobs, classifyScrapeError(err));')) return true;
  }
  return false;
}

function processFile(file: string, apply: boolean): FileResult {
  const buf = fs.readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const rawText = buf.toString('utf8');
  const body = hasBom ? rawText.slice(1) : rawText;
  const isCrlf = body.includes('\r\n');
  const text = body.split('\r\n').join('\n');

  if (/diagnostics/.test(text)) return { file, status: 'SKIPPED', reason: 'ALREADY_MIGRATED' };
  if (!siblingServiceMigrated(file)) {
    return { file, status: 'SKIPPED', reason: 'SERVICE_NOT_MIGRATED' };
  }

  const anchors = text.match(new RegExp(ANCHOR.source, 'gm')) ?? [];
  if (anchors.length === 0) return { file, status: 'SKIPPED', reason: 'NO_ANCHOR' };
  if (anchors.length > 1) return { file, status: 'SKIPPED', reason: 'MULTI_ANCHOR' };

  const out = text.replace(new RegExp(ANCHOR.source, 'm'), (_m, i1: string, i2: string) =>
    [
      `${i1}expect(result.jobs).toEqual([]);`,
      `${i1}// jobs alone stays empty whatever the plugin reports, so this is the`,
      `${i1}// assertion that pins the diagnostics contract. The mock throws a 500.`,
      `${i1}expect(result.diagnostics?.reason).toBe('fetch_error');`,
      `${i2}expect(mockGet).toHaveBeenCalledTimes(1);`,
    ].join('\n'),
  );

  const parsed = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true);
  const parseErrors = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) return { file, status: 'CORRUPT', detail: 'parse diagnostics' };
  if ((out.match(/result\.diagnostics\?\.reason/g) ?? []).length !== 1) {
    return { file, status: 'CORRUPT', detail: 'expected exactly one diagnostics assertion' };
  }
  if (out.split('\n').length - text.split('\n').length !== 3) {
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
    console.error('--expect=<n> is required.');
    process.exit(2);
  }
  const expect = Number(expectArg.split('=')[1]);

  const results = listSpecFiles().map((f) => processFile(f, apply));
  const transformed = results.filter((r) => r.status === 'TRANSFORMED');
  const corrupt = results.filter((r) => r.status === 'CORRUPT');
  const skipped = results.filter((r) => r.status === 'SKIPPED');

  const byReason: Record<string, number> = {};
  for (const s of skipped) byReason[s.reason!] = (byReason[s.reason!] ?? 0) + 1;

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: transformed=${transformed.length} skipped=${skipped.length} corrupt=${corrupt.length}`);
  console.log('  skip reasons:', JSON.stringify(byReason));
  for (const c of corrupt) console.error(`  CORRUPT ${c.file}: ${c.detail}`);

  const allowed = new Set(['ALREADY_MIGRATED', 'SERVICE_NOT_MIGRATED', 'NO_ANCHOR']);
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
