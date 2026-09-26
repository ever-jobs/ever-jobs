/**
 * Unit tests for `scripts/wire-company-source-tail.ts` (Spec 1735).
 *
 * The transform is pure, so it runs against miniature copies of the four shared
 * wiring files. The properties that matter for concurrent branches: every
 * addition lands at the TAIL of its block (so a rebase is a keep-both), a
 * re-run is a no-op, and a key/value collision fails before anything changes.
 */
import { siteMembers, WiringSources, wireTail } from '../wire-company-source-tail';

const SOURCES: WiringSources = {
  siteEnum: [
    'export enum Site {',
    "  LINKEDIN = 'linkedin',",
    '  // Phase 1: Spec 5152 — Source Company Plugin: Soundryx',
    "  SOUNDRYX = 'soundryx',",
    '}',
    '',
    '/**',
    ' * Map a raw string (case-insensitive) to a Site enum value.',
    ' */',
    'export function mapStringToSite(siteName: string): Site {',
    '  return siteName as Site;',
    '}',
    '',
  ].join('\n'),
  pluginsIndex: [
    '﻿/**',
    ' * Barrel.',
    ' */',
    "import { LinkedInModule } from './source-linkedin';",
    "import { SoundryxModule } from './source-company-soundryx';",
    'export const ALL_SOURCE_MODULES = [',
    '  LinkedInModule,',
    '  SoundryxModule,',
    '];',
    '',
  ].join('\n'),
  tsconfig: [
    '{',
    '  "compilerOptions": {',
    '    "paths": {',
    '      "@ever-jobs/models": ["packages/models/src/index.ts"],',
    '      "@ever-jobs/source-company-abbvie": ["packages/plugins/source-company-abbvie/src/index.ts"],',
    '      "@ever-jobs/source-company-soundryx": ["packages/plugins/source-company-soundryx/src/index.ts"],',
    '      "@ever-jobs/source-tesla": ["packages/plugins/source-tesla/src/index.ts"]',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'),
  jestConfig: [
    'module.exports = {',
    '  moduleNameMapper: {',
    "    '^@ever-jobs/source-company-abbvie$': '<rootDir>/packages/plugins/source-company-abbvie/src/index.ts',",
    "    '^@ever-jobs/source-company-soundryx$': '<rootDir>/packages/plugins/source-company-soundryx/src/index.ts',",
    "    '^@ever-jobs/source-tesla$': '<rootDir>/packages/plugins/source-tesla/src/index.ts',",
    '  },',
    "  transformIgnorePatterns: ['node_modules[/\\\\](?!(uuid)[/\\\\])'],",
    '};',
    '',
  ].join('\n'),
};

const BATCH = [
  { key: 'salesforce', enumKey: 'SALESFORCE', className: 'Salesforce', displayName: 'Salesforce', specNo: 1736 },
  { key: '3m', enumKey: 'THREE_M', className: 'ThreeM', displayName: '3M', specNo: 1736 },
];

function lines(s: string): string[] {
  return s.split('\n');
}

describe('wireTail', () => {
  const out = wireTail(SOURCES, BATCH);

  it('appends Site members just above the enum closing brace, in batch order', () => {
    const l = lines(out.siteEnum);
    const close = l.indexOf('}');
    expect(l.slice(close - 4, close)).toEqual([
      '  // Spec 1736 — Source Company Plugin: Salesforce',
      "  SALESFORCE = 'salesforce',",
      '  // Spec 1736 — Source Company Plugin: 3M',
      "  THREE_M = '3m',",
    ]);
    expect(siteMembers(out.siteEnum).get('THREE_M')).toBe('3m');
  });

  it('appends imports after the last import and modules at the end of ALL_SOURCE_MODULES', () => {
    const l = lines(out.pluginsIndex);
    expect(l[0].charCodeAt(0)).toBe(0xfeff);
    const arr = l.indexOf('export const ALL_SOURCE_MODULES = [');
    expect(l.slice(arr - 3, arr)).toEqual([
      "import { SoundryxModule } from './source-company-soundryx';",
      "import { SalesforceModule } from './source-company-salesforce';",
      "import { ThreeMModule } from './source-company-3m';",
    ]);
    const close = l.indexOf('];');
    expect(l.slice(close - 3, close)).toEqual(['  SoundryxModule,', '  SalesforceModule,', '  ThreeMModule,']);
  });

  it('appends path aliases and jest mappers after the last company entry', () => {
    const ts = lines(out.tsconfig);
    const tesla = ts.findIndex((x) => x.includes('source-tesla'));
    expect(ts[tesla - 1]).toBe('      "@ever-jobs/source-company-3m": ["packages/plugins/source-company-3m/src/index.ts"],');
    expect(ts[tesla - 2]).toContain('source-company-salesforce');
    expect(ts[tesla - 3]).toContain('source-company-soundryx');
    expect(() => JSON.parse(out.tsconfig)).not.toThrow();

    const jest = lines(out.jestConfig);
    const jTesla = jest.findIndex((x) => x.includes('source-tesla'));
    expect(jest[jTesla - 1]).toBe(
      "    '^@ever-jobs/source-company-3m$': '<rootDir>/packages/plugins/source-company-3m/src/index.ts',",
    );
    // `$'` in the mapper keys must survive verbatim (no replace-pattern expansion).
    expect(out.jestConfig).toContain("'^@ever-jobs/source-company-soundryx$'");
    expect(out.jestConfig).toContain("transformIgnorePatterns: ['node_modules[/\\\\](?!(uuid)[/\\\\])']");
  });

  it('is a pure tail addition: every original line survives in order', () => {
    for (const k of Object.keys(SOURCES) as Array<keyof WiringSources>) {
      const before = lines(SOURCES[k]);
      const after = lines(out[k]);
      let i = 0;
      for (const line of after) if (line === before[i]) i++;
      expect(i).toBe(before.length);
      expect(after.length - before.length).toBe(k === 'siteEnum' || k === 'pluginsIndex' ? 4 : 2);
    }
  });

  it('is idempotent', () => {
    expect(wireTail(out, BATCH)).toEqual(out);
  });

  it('fails without partial writes when a key or value is taken', () => {
    expect(() =>
      wireTail(SOURCES, [{ key: 'linkedin2', enumKey: 'LINKEDIN', className: 'X', displayName: 'X', specNo: 1 }]),
    ).toThrow(/Site.LINKEDIN already exists/);
    expect(() =>
      wireTail(SOURCES, [{ key: 'soundryx', enumKey: 'SOUNDRYX_TWO', className: 'X', displayName: 'X', specNo: 1 }]),
    ).toThrow(/already used by Site.SOUNDRYX/);
  });
});
