/**
 * Codemod (Spec 1682, pass 2) — pin the `not_registered` contract in the 699
 * delegating plugin specs.
 *
 * Their registry-miss test asserted only `expect(result.jobs).toHaveLength(0)`,
 * which stays true whatever the plugin reports. It passed before the service
 * codemod and would pass after a botched one, so it is not evidence of
 * anything. This adds the assertion that actually pins the contract.
 *
 * Same validating-transform discipline as the service pass: precondition gate,
 * postcondition gate, EOL/BOM preserved, fail-loud on any count mismatch.
 *
 * Usage:
 *   ts-node scripts/codemod/delegating-diagnostics-specs.ts --expect=699
 *   ts-node scripts/codemod/delegating-diagnostics-specs.ts --expect=699 --apply
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const PLUGINS_DIR = path.join(process.cwd(), 'packages', 'plugins');

/** The generated registry-miss assertion, emitted identically by all five scaffolders. */
const ANCHOR =
  /^([ \t]*)expect\(result\.jobs\)\.toHaveLength\(0\);\n([ \t]*)\}\);\n([ \t]*)\}\);$/m;

interface FileResult {
  file: string;
  status: 'TRANSFORMED' | 'SKIPPED' | 'CORRUPT';
  reason?: string;
  detail?: string;
}

function listSpecFiles(): string[] {
  const out: string[] = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    if (!dir.startsWith('source-company-')) continue;
    const testDir = path.join(PLUGINS_DIR, dir, '__tests__');
    if (!fs.existsSync(testDir)) continue;
    for (const f of fs.readdirSync(testDir)) {
      if (f.endsWith('.service.spec.ts')) out.push(path.join(testDir, f));
    }
  }
  return out.sort();
}

/** The backend label lives in the sibling service, already migrated by pass 1. */
function backendLabelFor(specFile: string): string | null {
  const srcDir = path.join(path.dirname(path.dirname(specFile)), 'src');
  if (!fs.existsSync(srcDir)) return null;
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.service.ts')) continue;
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    const m = text.match(/new ScrapeDiagnostics\('not_registered', '([^']+) source plugin/);
    if (m) return m[1];
  }
  return null;
}

function processFile(file: string, apply: boolean): FileResult {
  const buf = fs.readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const rawText = buf.toString('utf8');
  const body = hasBom ? rawText.slice(1) : rawText;
  const isCrlf = body.includes('\r\n');
  const text = body.split('\r\n').join('\n');

  if (!/when no registry is injected/.test(text)) {
    return { file, status: 'SKIPPED', reason: 'NOT_DELEGATING' };
  }
  if (/not_registered/.test(text)) {
    return { file, status: 'SKIPPED', reason: 'ALREADY_MIGRATED' };
  }

  const label = backendLabelFor(file);
  if (!label) return { file, status: 'SKIPPED', reason: 'NO_BACKEND_LABEL' };

  const matches = text.match(new RegExp(ANCHOR.source, 'gm')) ?? [];
  if (matches.length === 0) return { file, status: 'SKIPPED', reason: 'NO_ANCHOR' };
  if (matches.length > 1) return { file, status: 'SKIPPED', reason: 'MULTI_ANCHOR' };

  const out = text.replace(
    new RegExp(ANCHOR.source, 'm'),
    (_m, i1: string, i2: string, i3: string) =>
      [
        `${i1}expect(result.jobs).toHaveLength(0);`,
        `${i1}// jobs alone stays empty whatever the plugin reports, so this is the`,
        `${i1}// assertion that distinguishes a wiring fault from an empty board.`,
        `${i1}expect(result.diagnostics?.reason).toBe('not_registered');`,
        `${i1}expect(result.diagnostics?.detail).toContain('${label}');`,
        `${i2}});`,
        `${i3}});`,
      ].join('\n'),
  );

  const parsed = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true);
  const parseErrors = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) return { file, status: 'CORRUPT', detail: 'parse diagnostics' };
  if ((out.match(/not_registered/g) ?? []).length !== 1) {
    return { file, status: 'CORRUPT', detail: 'expected exactly one not_registered' };
  }
  if (out.split('\n').length - text.split('\n').length !== 4) {
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
