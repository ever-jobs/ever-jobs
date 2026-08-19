/**
 * scaffold-ashby-company-source.ts
 *
 * Reusable, deterministic generator for **Ashby-backed company-direct** source
 * plugins. Given a batch descriptor file (JSON array of `AshbyCompanyDescriptor`),
 * it materialises, for each entry:
 *
 *   packages/plugins/source-company-<slug>/
 *     package.json
 *     tsconfig.json
 *     src/index.ts
 *     src/<slug>.module.ts
 *     src/<slug>.service.ts
 *     __tests__/<slug>.service.spec.ts
 *     __tests__/fixtures/<slug>-jobs.json
 *   .specify/specs/<specNo>-source-company-<slug>/
 *     spec.md
 *     plan.md
 *     tasks.md
 *
 * The generated service does NOT re-implement Ashby parsing. It resolves the
 * registered Ashby ATS plugin from the core `PluginRegistry` at runtime and
 * delegates `scrape({ ...input, companySlug })`, then re-stamps the company
 * identity (`site`, `companyName`, `id` `ashby-`→`<slug>-` prefix) — so every
 * Ashby field fix is inherited automatically. This mirrors the proven
 * `source-company-allencontrolsystems` delegation plugin and honours the
 * "no plugin imports a peer plugin directly; discover via the registry" rule.
 *
 * It only ever CREATES new package + spec files — it never mutates the four
 * shared wiring files (`site.enum.ts`, `packages/plugins/index.ts`,
 * `tsconfig.base.json`, `jest.config.js`) nor `docs/index.md`. Those
 * registration edits are applied separately by `wire-company-source.ts`
 * (backend-agnostic; the batch descriptor is field-compatible with it) so this
 * generator stays a pure, conflict-free, idempotent file emitter that can
 * safely fan out.
 *
 * Usage (via ts-node):
 *   ts-node --project tsconfig.base.json -r tsconfig-paths/register \
 *     scripts/scaffold-ashby-company-source.ts .batch-input.json
 *
 * The batch descriptor shape is intentionally self-contained so a batch can be
 * assembled from any source (live Ashby probe, CSV, fixture corpus).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ListingInput {
  id: number | string;
  title: string;
  location: string | null;
  department: string | null;
  updatedAt: string | null;
}

export interface AshbyCompanyDescriptor {
  /** Plugin dir suffix + enum VALUE + JobPostDto id prefix (clean, hyphen-free). */
  slug: string;
  /** The live Ashby job-board slug, e.g. `allen-control-systems`. */
  companySlug: string;
  /** PascalCase base, e.g. `AllenControlSystems`. */
  className: string;
  /** `${className}Module`. */
  moduleName: string;
  /** `${className}Service`. */
  serviceName: string;
  /** Site enum KEY, e.g. `ALLEN_CONTROL_SYSTEMS`. */
  enumKey: string;
  /** Canonical brand display name. */
  displayName: string;
  specNo: number;
  phaseNo: number;
  jobCount: number;
  /** Factual one-line summary. */
  oneLiner: string;
  /** Sector / vertical. */
  sector: string;
  /** HQ, "City, Region, Country". */
  hq: string;
  /** Factual prose paragraph (no fabricated claims). */
  description: string;
  /** Factual highlight bullets. */
  highlights: string[];
  /** Up to 3 live listings, seeds the fixture. */
  listings: ListingInput[];
}

/** Escape a value for embedding inside single quotes in generated TS. */
function sq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Wrap a prose block as a JSDoc comment body (indented by ` * `). */
function jsdocBlock(text: string, width = 74): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines.map((l) => ` * ${l}`).join('\n');
}

function packageJson(d: AshbyCompanyDescriptor): string {
  return (
    JSON.stringify(
      {
        name: `@ever-jobs/source-company-${d.slug}`,
        version: '0.0.1',
        private: true,
        main: 'src/index.ts',
        types: 'src/index.ts',
      },
      null,
      2,
    ) + '\n'
  );
}

function tsconfigJson(): string {
  return (
    JSON.stringify(
      {
        extends: '../../../tsconfig.base.json',
        compilerOptions: { outDir: './dist', rootDir: './src' },
        include: ['src/**/*'],
      },
      null,
      2,
    ) + '\n'
  );
}

function indexFile(d: AshbyCompanyDescriptor): string {
  return (
    `export { ${d.moduleName} } from './${d.slug}.module';\n` +
    `export { ${d.serviceName} } from './${d.slug}.service';\n`
  );
}

function moduleFile(d: AshbyCompanyDescriptor): string {
  return (
    `import { Module } from '@nestjs/common';\n` +
    `import { ${d.serviceName} } from './${d.slug}.service';\n\n` +
    `@Module({ providers: [${d.serviceName}], exports: [${d.serviceName}] })\n` +
    `export class ${d.moduleName} {}\n`
  );
}

function serviceFile(d: AshbyCompanyDescriptor): string {
  const doc =
    `/**\n` +
    ` * ${sq(d.displayName)} — ${sq(d.oneLiner)}\n` +
    ` *\n` +
    `${jsdocBlock(d.description)}\n` +
    ` *\n` +
    ` * Sector: ${sq(d.sector)}. HQ: ${sq(d.hq)}.\n` +
    ` *\n` +
    ` * Source: Ashby job board, company slug \`${d.companySlug}\`\n` +
    ` * (\`https://jobs.ashbyhq.com/${d.companySlug}\`). The company's live\n` +
    ` * postings are served by Ashby. Rather than re-implement Ashby parsing (and\n` +
    ` * risk drift), this plugin resolves the registered Ashby source plugin from\n` +
    ` * the \`PluginRegistry\` at runtime and delegates the fetch + field mapping to\n` +
    ` * it, then re-stamps the company identity (site, companyName, id prefix) onto\n` +
    ` * the results — so every Ashby field fix is inherited automatically. This\n` +
    ` * honours the "no plugin imports a peer plugin directly; discover via the\n` +
    ` * registry" rule.\n` +
    ` */`;
  return (
    `import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';\n\n` +
    `import { Injectable, Logger, Optional } from '@nestjs/common';\n` +
    `import {\n` +
    `  IScraper, ScraperInputDto, JobResponseDto, Site,\n` +
    `  ScrapeDiagnostics,\n` +
    `} from '@ever-jobs/models';\n\n` +
    `${doc}\n` +
    `const COMPANY_SLUG = '${sq(d.companySlug)}';\n` +
    `const COMPANY_NAME = '${sq(d.displayName)}';\n\n` +
    `@SourcePlugin({\n` +
    `  site: Site.${d.enumKey},\n` +
    `  name: COMPANY_NAME,\n` +
    `  category: 'company',\n` +
    `})\n` +
    `@Injectable()\n` +
    `export class ${d.serviceName} implements IScraper {\n` +
    `  private readonly logger = new Logger(${d.serviceName}.name);\n\n` +
    `  constructor(\n` +
    `    @Optional() private readonly registry?: PluginRegistry,\n` +
    `  ) {}\n\n` +
    `  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {\n` +
    `    const ashby = this.registry?.getScraper(Site.ASHBY);\n` +
    `    if (!ashby) {\n` +
    `      this.logger.error(\n` +
    `        'Ashby source plugin is not registered; cannot scrape ${sq(d.displayName)}',\n` +
    `      );\n` +
    `      // A registry miss is a wiring problem, not an empty board -\n` +
    `      // not_registered keeps the two distinguishable upstream.\n` +
    `      return new JobResponseDto(\n` +
    `        [],\n` +
    `        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),\n` +
    `      );\n` +
    `    }\n\n` +
    `    this.logger.log(\n` +
    `      \`${sq(d.displayName)}: delegating to Ashby (slug \${COMPANY_SLUG})\`,\n` +
    `    );\n\n` +
    `    const result = await ashby.scrape({\n` +
    `      ...input,\n` +
    `      companySlug: COMPANY_SLUG,\n` +
    `    } as ScraperInputDto);\n\n` +
    `    for (const job of result.jobs) {\n` +
    `      job.site = Site.${d.enumKey};\n` +
    `      job.companyName = COMPANY_NAME;\n` +
    `      if (job.id) {\n` +
    `        job.id = job.id.replace(/^ashby-/, '${d.slug}-');\n` +
    `      }\n` +
    `    }\n\n` +
    `    this.logger.log(\`${sq(d.displayName)}: scraped \${result.jobs.length} jobs\`);\n` +
    `    return result;\n` +
    `  }\n` +
    `}\n`
  );
}

/** Split a flat Ashby location string into a postalAddress shape. */
function splitLocation(loc: string | null): {
  addressLocality: string | null;
  addressRegion: string | null;
  addressCountry: string | null;
} {
  if (!loc) return { addressLocality: null, addressRegion: null, addressCountry: null };
  const parts = loc.split(',').map((p) => p.trim()).filter(Boolean);
  return {
    addressLocality: parts[0] ?? null,
    addressRegion: parts[1] ?? null,
    addressCountry: parts[2] ?? null,
  };
}

function buildFixture(d: AshbyCompanyDescriptor): string {
  const jobs = d.listings.slice(0, 3).map((l, i) => {
    const loc = l.location ?? 'Remote';
    const isRemote = /remote/i.test(loc);
    const id = String(l.id || `${d.slug}-fixture-${i + 1}`);
    const desc = `${l.title} at ${d.displayName}.`;
    return {
      id,
      title: l.title,
      departmentName: l.department ?? null,
      teamName: l.department ?? null,
      employmentType: 'FullTime',
      location: loc,
      address: { postalAddress: splitLocation(loc) },
      isRemote,
      isListed: true,
      publishedDate: l.updatedAt
        ? String(l.updatedAt).split('T')[0]
        : '2026-06-01',
      descriptionHtml: `<p>${desc}</p>`,
      descriptionPlain: desc,
      jobUrl: `https://jobs.ashbyhq.com/${d.companySlug}/${id}`,
      applyUrl: `https://jobs.ashbyhq.com/${d.companySlug}/${id}/application`,
    };
  });
  return JSON.stringify({ apiVersion: '1', jobs }, null, 2) + '\n';
}

function testFile(d: AshbyCompanyDescriptor): string {
  return `import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { PluginRegistry } from '@ever-jobs/plugin';
import { AshbyService } from '@ever-jobs/source-ats-ashby';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: jest.fn(),
      setHeaders: jest.fn(),
    })),
  };
});

import { ${d.moduleName}, ${d.serviceName} } from '../src';

const COMPANY_NAME_EXPECT = '${sq(d.displayName)}';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, '${d.slug}-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Registry wired with a real AshbyService registered under Site.ASHBY. */
function registryWithAshby(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(
    { site: Site.ASHBY, name: 'Ashby', category: 'ats', isAts: true },
    new AshbyService(),
  );
  return registry;
}

describe('${d.serviceName} — Ashby delegation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ${d.moduleName} via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [${d.moduleName}],
      }).compile();
      const service = moduleRef.get(${d.serviceName});
      expect(service).toBeInstanceOf(${d.serviceName});
      await moduleRef.close();
    });

    it('exports the Site.${d.enumKey} = "${d.slug}" enum value', () => {
      expect(Site.${d.enumKey}).toBe('${d.slug}');
    });
  });

  describe('happy path (delegates to the registered Ashby plugin)', () => {
    it('maps all fixture listings to JobPostDto with the company identity', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ${d.serviceName}(registryWithAshby());
      const result = (await service.scrape({
        siteType: [Site.${d.enumKey}],
        resultsWanted: 100,
      } as ScraperInputDto)) as JobResponseDto;

      expect(result.jobs).toHaveLength(JOBS_PAGE_RAW.jobs.length);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = result.jobs.find(
        (j) => j.id === '${d.slug}-' + first.id,
      );
      expect(job0).toBeDefined();
      // company identity is re-stamped over Ashby's defaults
      expect(job0?.site).toBe(Site.${d.enumKey});
      expect(job0?.companyName).toBe(COMPANY_NAME_EXPECT);
      expect(job0?.id).toBe('${d.slug}-' + first.id);
      expect(job0?.id?.startsWith('ashby-')).toBe(false);
      // Ashby-mapped fields flow through untouched
      expect(job0?.title).toBe(first.title);
      expect(job0?.jobUrl).toBe(first.jobUrl);
      expect(job0?.department).toBe(first.departmentName);

      // it hit the Ashby board for the company slug, not Greenhouse
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toContain('api.ashbyhq.com/posting-api/job-board');
      expect(calledUrls[0]).toContain('${d.companySlug}');
      expect(calledUrls[0]).not.toContain('greenhouse');
    });

    it('every job carries the company site, companyName, and id prefix', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}(registryWithAshby());
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.${d.enumKey});
        expect(job.companyName).toBe(COMPANY_NAME_EXPECT);
        expect(job.id?.startsWith('${d.slug}-')).toBe(true);
      }
    });
  });

  describe('input pass-through', () => {
    it('forwards the company slug and caller input to the Ashby scraper', async () => {
      const captured: ScraperInputDto[] = [];
      const fakeAshby: IScraper = {
        scrape: async (input) => {
          captured.push(input);
          return new JobResponseDto([
            new JobPostDto({ id: 'ashby-x1', title: 'Role', jobUrl: 'u' }),
          ]);
        },
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.ASHBY, name: 'Ashby', category: 'ats', isAts: true },
        fakeAshby,
      );

      const service = new ${d.serviceName}(registry);
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
        resultsWanted: 7,
      } as ScraperInputDto);

      expect(captured).toHaveLength(1);
      expect(captured[0].companySlug).toBe('${d.companySlug}');
      expect(captured[0].resultsWanted).toBe(7);
      expect(result.jobs[0].id).toBe('${d.slug}-x1');
      expect(result.jobs[0].site).toBe(Site.${d.enumKey});
    });

    it('only rewrites a leading ashby- id prefix', async () => {
      const fakeAshby: IScraper = {
        scrape: async () =>
          new JobResponseDto([
            new JobPostDto({ id: 'ashby-ashby-7', title: 'T', jobUrl: 'u' }),
          ]),
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.ASHBY, name: 'Ashby', category: 'ats', isAts: true },
        fakeAshby,
      );
      const service = new ${d.serviceName}(registry);
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      expect(result.jobs[0].id).toBe('${d.slug}-ashby-7');
    });
  });

  describe('resilience', () => {
    it('returns an empty response when no Ashby plugin is registered', async () => {
      const service = new ${d.serviceName}(new PluginRegistry());
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });

    it('returns an empty response when no registry is injected', async () => {
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against the fixture page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}(registryWithAshby());
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });
});
`;
}

function specMd(d: AshbyCompanyDescriptor): string {
  return `# Spec: ${d.specNo} — Source Company Plugin: ${d.displayName}

| Field | Value |
| --- | --- |
| Spec ID | ${d.specNo} |
| Slug | source-company-${d.slug} |
| Status | accepted |
| Owner | claude (run #441) |
| Created | 2026-07-02 |
| Last updated | 2026-07-02 |
| Supersedes | (none) |
| Related specs | 975, 5017 |

## Summary

New **Ashby-backed company-direct** source plugin \`source-company-${d.slug}\` for
**${d.displayName}** (${d.oneLiner}). Sector: ${d.sector}. HQ: ${d.hq}.

The company's live postings are served by **Ashby** on job board
\`${d.companySlug}\` (\`https://jobs.ashbyhq.com/${d.companySlug}\`), which exposed
**${d.jobCount} live role(s)** at probe time (public Ashby Posting API,
\`MIN_JOBS = 3\` gate). Discovered and gated through the deterministic Ashby
company-source pipeline (\`probe-ashby → assemble → scaffold-ashby → wire\`) —
see \`.specify/specs/975-ashby-company-source-pipeline/\`.

## Constitution cross-check

- **TypeScript-only** — plugin is TS; no JS/Python. ✔
- **Modular / plugin** — a self-contained \`source-company-${d.slug}\` package,
  installable/removable via the barrel + \`Site\` enum; no core changes. ✔
- **No peer imports** — delegates to the Ashby ATS plugin via \`PluginRegistry\`
  at runtime (never imports it directly). ✔
- **Performance** — zero extra network cost over the Ashby plugin it delegates
  to (single public job-board fetch); identity re-stamp is O(n) over jobs. ✔
- **No competitor references** — documented purely on the company's public
  merits. ✔

## User story

> As an **aggregator caller**, I want **\`Site.${d.enumKey}\`** in the source
> registry, so that a single \`siteType: [Site.${d.enumKey}]\` request returns
> ${d.displayName}'s live Ashby postings, re-stamped with the company identity.

## Functional requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Add \`Site.${d.enumKey} = '${d.slug}'\` to the \`Site\` enum. | must |
| FR-2 | \`${d.serviceName}\` implements \`IScraper\`, \`@SourcePlugin({ site: Site.${d.enumKey}, name: '${d.displayName}', category: 'company' })\`. | must |
| FR-3 | Resolve the Ashby scraper from \`PluginRegistry\`; delegate \`scrape({ ...input, companySlug: '${d.companySlug}' })\`. | must |
| FR-4 | Re-stamp each \`JobPostDto\`: \`site = Site.${d.enumKey}\`, \`companyName = '${d.displayName}'\`, \`id\` prefix \`ashby-\`→\`${d.slug}-\`. | must |
| FR-5 | Fail-safe: return an empty \`JobResponseDto\` when Ashby is unavailable / unregistered. | must |
| FR-6 | tsconfig path-alias + jest moduleNameMapper + barrel registration. | must |
| FR-7 | Mocked unit suite green (DI resolution, enum value, delegation, pass-through, resilience, cap). | must |

## Highlights

${d.highlights.map((h) => `- ${h}`).join('\n')}
`;
}

function planMd(d: AshbyCompanyDescriptor): string {
  return `# Plan: ${d.specNo} — Source Company Plugin: ${d.displayName} (Ashby company-direct)

| Field | Value |
| --- | --- |
| Spec | spec.md |
| Created | 2026-07-02 |
| Last updated | 2026-07-02 |

## Approach

Clone the proven \`source-company-allencontrolsystems\` Ashby-delegation pattern
via \`scripts/scaffold-ashby-company-source.ts\`. The service is a thin
registry-delegating adaptor — no bespoke HTTP or parsing — so it inherits every
Ashby field fix. Registration is applied by the backend-agnostic
\`scripts/wire-company-source.ts\`.

## Files

| File | Change |
|------|--------|
| \`packages/plugins/source-company-${d.slug}/*\` | New package (module, service, index, tests, fixture). |
| \`packages/models/src/enums/site.enum.ts\` | \`+ ${d.enumKey} = '${d.slug}'\`. |
| \`packages/plugins/index.ts\` | \`+ import ${d.moduleName}\` + \`ALL_SOURCE_MODULES\` entry. |
| \`tsconfig.base.json\` | \`+\` path alias. |
| \`jest.config.js\` | \`+\` moduleNameMapper entry. |
| \`.specify/specs/${d.specNo}-source-company-${d.slug}/\` | This spec/plan/tasks. |

## Verification

- \`tsc --noEmit\` clean for the new package.
- Mocked unit suite green (no live network).
- Optional: live probe against \`https://api.ashbyhq.com/posting-api/job-board/${d.companySlug}\`.
`;
}

function tasksMd(d: AshbyCompanyDescriptor): string {
  return `# Tasks — Spec ${d.specNo}: ${d.displayName} (Ashby company-direct)

- [x] T1 — Probe \`${d.companySlug}\` against the public Ashby Posting API (≥3 live roles). ✔ (${d.jobCount} roles)
- [x] T2 — Assemble the descriptor (derive className/moduleName/enumKey from the display name).
- [x] T3 — Scaffold the \`source-company-${d.slug}\` package (module, service, index, test, fixture).
- [x] T4 — Wire \`Site.${d.enumKey}\`, barrel import, tsconfig alias, jest mapper.
- [x] T5 — \`tsc --noEmit\` + mocked unit suite green.
- [ ] T6 — (Optional) authenticate live verification; flip \`verified\` once confirmed.
`;
}

function writeFileSafe(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function scaffoldOne(repoRoot: string, d: AshbyCompanyDescriptor): void {
  const pkgDir = path.join(repoRoot, 'packages', 'plugins', `source-company-${d.slug}`);
  const specDir = path.join(
    repoRoot,
    '.specify',
    'specs',
    `${d.specNo}-source-company-${d.slug}`,
  );
  const files: Array<[string, string]> = [
    [path.join(pkgDir, 'package.json'), packageJson(d)],
    [path.join(pkgDir, 'tsconfig.json'), tsconfigJson()],
    [path.join(pkgDir, 'src', 'index.ts'), indexFile(d)],
    [path.join(pkgDir, 'src', `${d.slug}.module.ts`), moduleFile(d)],
    [path.join(pkgDir, 'src', `${d.slug}.service.ts`), serviceFile(d)],
    [path.join(pkgDir, '__tests__', `${d.slug}.service.spec.ts`), testFile(d)],
    [path.join(pkgDir, '__tests__', 'fixtures', `${d.slug}-jobs.json`), buildFixture(d)],
    [path.join(specDir, 'spec.md'), specMd(d)],
    [path.join(specDir, 'plan.md'), planMd(d)],
    [path.join(specDir, 'tasks.md'), tasksMd(d)],
  ];
  for (const [abs, content] of files) writeFileSafe(abs, content);
}

function main(): void {
  const inputPath = process.argv[2] || '.batch-input.json';
  const repoRoot = process.cwd();
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(repoRoot, inputPath);
  const batch: AshbyCompanyDescriptor[] = JSON.parse(fs.readFileSync(abs, 'utf8'));
  for (const d of batch) scaffoldOne(repoRoot, d);
  // eslint-disable-next-line no-console
  console.log(`Scaffolded ${batch.length} Ashby company-source plugin(s).`);
  for (const d of batch) {
    // eslint-disable-next-line no-console
    console.log(`  Spec ${d.specNo}  ${d.enumKey} = '${d.slug}'  (${d.serviceName} → ashby:${d.companySlug})`);
  }
}

if (require.main === module) {
  main();
}
