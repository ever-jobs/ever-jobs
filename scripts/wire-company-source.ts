/**
 * wire-company-source.ts
 *
 * Idempotent registration helper for the four shared wiring files that the
 * pure file-emitting `scaffold-company-source.ts` deliberately never touches:
 *
 *   1. packages/models/src/enums/site.enum.ts   — Site enum members
 *   2. packages/plugins/index.ts                — barrel imports + ALL_SOURCE_MODULES
 *   3. tsconfig.base.json                        — path aliases
 *   4. jest.config.js                            — moduleNameMapper entries
 *
 * Insertion is anchor-based (locate a stable marker substring, splice the new
 * block immediately after it). All `String.prototype.replace` calls use a
 * REPLACEMENT FUNCTION — never a replacement string — so that special
 * replacement patterns such as `$'` (which appears verbatim in the
 * jest.config.js mapper anchors) are inserted literally rather than expanded.
 *
 * Re-running is safe: each entry is skipped when its unique token already
 * exists in the target file.
 *
 * Usage:
 *   ts-node --project tsconfig.base.json -r tsconfig-paths/register \
 *     scripts/wire-company-source.ts .batch-input.json
 */
import * as fs from 'fs';
import * as path from 'path';

interface Descriptor {
  slug: string;
  moduleName: string;
  enumKey: string;
  displayName: string;
  specNo: number;
  phaseNo: number;
}

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}
function write(p: string, s: string): void {
  fs.writeFileSync(p, s);
}

function main(): void {
  const inputPath = process.argv[2] || '.batch-input.json';
  const repoRoot = process.cwd();
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(repoRoot, inputPath);
  const batch: Descriptor[] = JSON.parse(fs.readFileSync(abs, 'utf8'));

  // ---- 1. site.enum.ts -------------------------------------------------
  const enumPath = path.join(repoRoot, 'packages', 'models', 'src', 'enums', 'site.enum.ts');
  let enumSrc = read(enumPath);
  for (const d of batch) {
    if (enumSrc.includes(`${d.enumKey} = '${d.slug}'`)) continue;
    // Locate the enum's closing brace: the last `}` before `mapStringToSite`.
    const mapIdx = enumSrc.indexOf('mapStringToSite');
    if (mapIdx === -1) throw new Error('mapStringToSite marker not found');
    const braceIdx = enumSrc.lastIndexOf('}', mapIdx);
    if (braceIdx === -1) throw new Error('enum closing brace not found');
    // Back up to the start of the brace's own line so the block lands above it.
    const lineStart = enumSrc.lastIndexOf('\n', braceIdx) + 1;
    const block =
      `  // Phase ${d.phaseNo}: Spec ${d.specNo} — Source Company Plugin: ${d.displayName}\n` +
      `  ${d.enumKey} = '${d.slug}',\n`;
    enumSrc = enumSrc.slice(0, lineStart) + block + enumSrc.slice(lineStart);
  }
  write(enumPath, enumSrc);

  // ---- 2. packages/plugins/index.ts -----------------------------------
  const indexPath = path.join(repoRoot, 'packages', 'plugins', 'index.ts');
  let indexSrc = read(indexPath);
  for (const d of batch) {
    const importLine = `import { ${d.moduleName} } from './source-company-${d.slug}';\n`;
    if (!indexSrc.includes(importLine)) {
      const anchor = 'export const ALL_SOURCE_MODULES = [';
      const aIdx = indexSrc.indexOf(anchor);
      if (aIdx === -1) throw new Error('ALL_SOURCE_MODULES anchor not found');
      indexSrc = indexSrc.slice(0, aIdx) + importLine + indexSrc.slice(aIdx);
    }
    const moduleEntry = `  ${d.moduleName},\n`;
    if (!indexSrc.includes(moduleEntry)) {
      const closeIdx = indexSrc.indexOf('\n];', indexSrc.indexOf('export const ALL_SOURCE_MODULES'));
      if (closeIdx === -1) throw new Error('ALL_SOURCE_MODULES close not found');
      indexSrc = indexSrc.slice(0, closeIdx + 1) + moduleEntry + indexSrc.slice(closeIdx + 1);
    }
  }
  write(indexPath, indexSrc);

  // ---- 3. tsconfig.base.json ------------------------------------------
  const tsconfigPath = path.join(repoRoot, 'tsconfig.base.json');
  let tsSrc = read(tsconfigPath);
  for (const d of batch) {
    const alias = `"@ever-jobs/source-company-${d.slug}":`;
    if (tsSrc.includes(alias)) continue;
    const line =
      `      "@ever-jobs/source-company-${d.slug}": ["./packages/plugins/source-company-${d.slug}/src/index.ts"],\n`;
    // Anchor: the first existing source-company path alias line.
    const anchorMatch = tsSrc.match(/ {6}"@ever-jobs\/source-company-[^\n]+\n/);
    if (!anchorMatch) throw new Error('tsconfig source-company anchor not found');
    const aIdx = tsSrc.indexOf(anchorMatch[0]);
    tsSrc = tsSrc.slice(0, aIdx) + line + tsSrc.slice(aIdx);
  }
  write(tsconfigPath, tsSrc);

  // ---- 4. jest.config.js ----------------------------------------------
  const jestPath = path.join(repoRoot, 'jest.config.js');
  let jestSrc = read(jestPath);
  for (const d of batch) {
    const key = `'^@ever-jobs/source-company-${d.slug}$':`;
    if (jestSrc.includes(key)) continue;
    const line =
      `    '^@ever-jobs/source-company-${d.slug}$': '<rootDir>/packages/plugins/source-company-${d.slug}/src/index.ts',\n`;
    const anchorMatch = jestSrc.match(/ {4}'\^@ever-jobs\/source-company-[^\n]+\n/);
    if (!anchorMatch) throw new Error('jest source-company anchor not found');
    const aIdx = jestSrc.indexOf(anchorMatch[0]);
    jestSrc = jestSrc.slice(0, aIdx) + line + jestSrc.slice(aIdx);
  }
  write(jestPath, jestSrc);

  // eslint-disable-next-line no-console
  console.log(`Wired ${batch.length} company-source plugins into 4 shared files.`);
}

if (require.main === module) {
  main();
}
