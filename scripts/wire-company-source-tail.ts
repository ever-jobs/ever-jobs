/**
 * wire-company-source-tail.ts — Spec 1735
 *
 * Idempotent, **append-at-tail** registration of company-source plugins in the
 * four shared wiring files:
 *
 *   1. packages/models/src/enums/site.enum.ts — a `Site` member just above the
 *      enum's closing brace;
 *   2. packages/plugins/index.ts — the import after the last import, the module
 *      as the last `ALL_SOURCE_MODULES` entry;
 *   3. tsconfig.base.json — the path alias after the last
 *      `@ever-jobs/source-company-*` alias;
 *   4. jest.config.js — the `moduleNameMapper` entry after the last
 *      `^@ever-jobs/source-company-*` entry.
 *
 * `wire-company-source.ts` inserts tsconfig/jest entries at the FIRST company
 * alias and imports just above `ALL_SOURCE_MODULES`; that is fine for a single
 * writer, but when several branches register plugins concurrently every one of
 * them rewrites the same anchor region. Appending at the tail keeps each
 * branch's change a pure tail addition, so a later rebase is a mechanical
 * "keep both" resolution.
 *
 * Every entry is skipped when already present, and the run fails (before
 * writing anything) when an enum key or value is already taken by another
 * plugin. String splicing only — never `String.prototype.replace` with a
 * replacement string (`$'` appears verbatim in jest.config.js).
 *
 * Usage (via ts-node):
 *   ts-node --project tsconfig.base.json -r tsconfig-paths/register \
 *     scripts/wire-company-source-tail.ts scripts/seeds/ats-delegate-companies.json [key,key,...]
 */
import * as fs from 'fs';
import * as path from 'path';

export interface WireDescriptor {
  key: string;
  enumKey: string;
  className: string;
  displayName: string;
  specNo: number;
}

export interface WiringSources {
  siteEnum: string;
  pluginsIndex: string;
  tsconfig: string;
  jestConfig: string;
}

export const WIRING_PATHS: Record<keyof WiringSources, string> = {
  siteEnum: path.join('packages', 'models', 'src', 'enums', 'site.enum.ts'),
  pluginsIndex: path.join('packages', 'plugins', 'index.ts'),
  tsconfig: 'tsconfig.base.json',
  jestConfig: 'jest.config.js',
};

/** Index just past the end of the last line matching `re` (which must be /m and /g). */
function endOfLastLine(src: string, re: RegExp): number {
  let last = -1;
  for (const m of src.matchAll(re)) last = (m.index ?? 0) + m[0].length;
  if (last < 0) throw new Error(`anchor not found: ${re}`);
  const nl = src.indexOf('\n', last);
  return nl < 0 ? src.length : nl + 1;
}

function splice(src: string, at: number, text: string): string {
  return src.slice(0, at) + text + src.slice(at);
}

/** Existing `KEY = 'value'` members of the Site enum. */
export function siteMembers(siteEnum: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of siteEnum.matchAll(/^\s+([A-Z0-9_]+) = '([^']+)',?\s*$/gm)) out.set(m[1], m[2]);
  return out;
}

/**
 * Pure transform: append every descriptor not yet wired. Throws when a key or
 * value is taken by a different plugin.
 */
export function wireTail(src: WiringSources, batch: WireDescriptor[]): WiringSources {
  let { siteEnum, pluginsIndex, tsconfig, jestConfig } = src;
  const members = siteMembers(siteEnum);
  const values = new Map([...members].map(([k, v]) => [v, k]));

  for (const d of batch) {
    const moduleName = `${d.className}Module`;
    const pkg = `source-company-${d.key}`;

    // 1. Site enum.
    const existingValue = members.get(d.enumKey);
    const existingKey = values.get(d.key);
    if (existingValue !== undefined && existingValue !== d.key) {
      throw new Error(`Site.${d.enumKey} already exists with value '${existingValue}'`);
    }
    if (existingKey !== undefined && existingKey !== d.enumKey) {
      throw new Error(`Site value '${d.key}' already used by Site.${existingKey}`);
    }
    if (existingValue === undefined) {
      const mapIdx = siteEnum.indexOf('export function mapStringToSite');
      if (mapIdx < 0) throw new Error('mapStringToSite marker not found');
      const braceIdx = siteEnum.lastIndexOf('\n}', mapIdx);
      if (braceIdx < 0) throw new Error('Site enum closing brace not found');
      siteEnum = splice(
        siteEnum,
        braceIdx + 1,
        `  // Spec ${d.specNo} — Source Company Plugin: ${d.displayName}\n` +
          `  ${d.enumKey} = '${d.key}',\n`,
      );
      members.set(d.enumKey, d.key);
      values.set(d.key, d.enumKey);
    }

    // 2. Barrel import + ALL_SOURCE_MODULES entry.
    const importLine = `import { ${moduleName} } from './${pkg}';\n`;
    if (!pluginsIndex.includes(importLine)) {
      const arrayIdx = pluginsIndex.indexOf('export const ALL_SOURCE_MODULES');
      if (arrayIdx < 0) throw new Error('ALL_SOURCE_MODULES not found');
      const head = pluginsIndex.slice(0, arrayIdx);
      const at = endOfLastLine(head, /^import .*$/gm);
      pluginsIndex = splice(pluginsIndex, at, importLine);
    }
    const arrayIdx = pluginsIndex.indexOf('export const ALL_SOURCE_MODULES');
    const closeIdx = pluginsIndex.indexOf('\n];', arrayIdx);
    if (closeIdx < 0) throw new Error('ALL_SOURCE_MODULES close not found');
    const body = pluginsIndex.slice(arrayIdx, closeIdx);
    if (!new RegExp(`^\\s+${moduleName},\\s*$`, 'm').test(body)) {
      pluginsIndex = splice(pluginsIndex, closeIdx + 1, `  ${moduleName},\n`);
    }

    // 3. tsconfig path alias.
    const alias = `"@ever-jobs/${pkg}":`;
    if (!tsconfig.includes(alias)) {
      const at = endOfLastLine(tsconfig, /^ {6}"@ever-jobs\/source-company-[^"]+": .*$/gm);
      tsconfig = splice(
        tsconfig,
        at,
        `      "@ever-jobs/${pkg}": ["packages/plugins/${pkg}/src/index.ts"],\n`,
      );
    }

    // 4. jest moduleNameMapper.
    const mapperKey = `'^@ever-jobs/${pkg}$':`;
    if (!jestConfig.includes(mapperKey)) {
      const at = endOfLastLine(jestConfig, /^ {4}'\^@ever-jobs\/source-company-[^']+': .*$/gm);
      jestConfig = splice(
        jestConfig,
        at,
        `    '^@ever-jobs/${pkg}$': '<rootDir>/packages/plugins/${pkg}/src/index.ts',\n`,
      );
    }
  }

  return { siteEnum, pluginsIndex, tsconfig, jestConfig };
}

function main(): void {
  const [seedPath, onlyArg] = process.argv.slice(2);
  if (!seedPath) throw new Error('usage: wire-company-source-tail.ts <seeds.json> [key,key,...]');
  const repoRoot = process.cwd();
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
  const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
  const batch: WireDescriptor[] = (JSON.parse(fs.readFileSync(abs(seedPath), 'utf8')) as WireDescriptor[])
    .filter((d) => !only || only.has(d.key));

  const read = (k: keyof WiringSources) => fs.readFileSync(path.join(repoRoot, WIRING_PATHS[k]), 'utf8');
  const before: WiringSources = {
    siteEnum: read('siteEnum'),
    pluginsIndex: read('pluginsIndex'),
    tsconfig: read('tsconfig'),
    jestConfig: read('jestConfig'),
  };
  // Throws before any file is written.
  const after = wireTail(before, batch);
  for (const k of Object.keys(WIRING_PATHS) as Array<keyof WiringSources>) {
    if (after[k] !== before[k]) fs.writeFileSync(path.join(repoRoot, WIRING_PATHS[k]), after[k]);
  }
  // eslint-disable-next-line no-console
  console.log(`Wired ${batch.length} company-source plugin(s) at the tail of 4 shared files.`);
}

if (require.main === module) {
  main();
}
