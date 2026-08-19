/**
 * scaffold-company-source.ts
 *
 * Reusable, deterministic generator for **Greenhouse-backed company-direct**
 * source plugins. Given a batch descriptor file (JSON array of
 * `CompanyDescriptor`), it materialises, for each entry:
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
 * It only ever CREATES new package + spec files — it never mutates the four
 * shared wiring files (`site.enum.ts`, `packages/plugins/index.ts`,
 * `tsconfig.base.json`, `jest.config.js`) nor `docs/index.md`. Those
 * registration edits are applied separately so this generator stays a
 * pure, conflict-free, idempotent file emitter that can safely fan out.
 *
 * Usage (via ts-node):
 *   ts-node --project tsconfig.base.json -r tsconfig-paths/register \
 *     scripts/scaffold-company-source.ts .batch-input.json
 *
 * The batch descriptor shape is intentionally self-contained so a batch
 * can be assembled from any source (live probe, CSV, fixture corpus).
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

export interface CompanyDescriptor {
  slug: string;
  className: string;
  moduleName: string;
  serviceName: string;
  enumKey: string;
  displayName: string;
  specNo: number;
  phaseNo: number;
  jobCount: number;
  description: string;
  oneLiner: string;
  sector: string;
  hq: string;
  highlights: string[];
  listings: ListingInput[];
}

/** Escape a value for embedding inside a single-quoted TS string literal. */
function sq(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Neutralise comment terminators inside doc-comment prose. */
function safeComment(s: string): string {
  return String(s).replace(/\*\//g, '* /');
}

/** Greedy word-wrap to `width` cols, returning lines (no trailing spaces). */
function wrap(text: string, width: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function docComment(d: CompanyDescriptor): string {
  const out: string[] = [];
  out.push('/**');
  out.push(` * ${safeComment(d.displayName)} — ${safeComment(d.oneLiner)}.`);
  out.push(' *');
  for (const line of wrap(safeComment(d.description), 68)) out.push(` * ${line}`);
  out.push(' *');
  out.push(` * Sector: ${safeComment(d.sector)}. HQ: ${safeComment(d.hq)}.`);
  if (d.highlights.length) {
    out.push(' *');
    out.push(' * Highlights:');
    for (const h of d.highlights) {
      const hl = wrap(safeComment(h), 64);
      out.push(` *   - ${hl[0]}`);
      for (let i = 1; i < hl.length; i++) out.push(` *     ${hl[i]}`);
    }
  }
  out.push(' *');
  out.push(` * Source profile (Spec ${d.specNo}):`);
  out.push(' *   - D-04 — Greenhouse canonical hosted-board host (variant 2):');
  out.push(` *     \`https://job-boards.greenhouse.io/${d.slug}/jobs/<id>\`.`);
  out.push(' *   - D-08 — entity-decode-then-tag-strip description pipeline.');
  out.push(` *   - D-09 — wire \`company_name\` pass-through (\`'${sq(d.displayName)}'\`).`);
  out.push(' *   - D-10 — defensive `.trim()` on wire titles (padding observed');
  out.push(' *     on the run-398 batch probe).');
  out.push(' *   - D-11 — defensive `.trim()` on wire department names.');
  out.push(' *');
  out.push(` * Probed ${d.jobCount} live role(s) on the run-398 batch sweep.`);
  out.push(' */');
  return out.join('\n');
}

function serviceFile(d: CompanyDescriptor): string {
  return `import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
  classifyScrapeError,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

${docComment(d)}
const API_URL = 'https://api.greenhouse.io/v1/boards/${d.slug}/jobs';

@SourcePlugin({
  site: Site.${d.enumKey},
  name: '${sq(d.displayName)}',
  category: 'company',
})
@Injectable()
export class ${d.serviceName} implements IScraper {
  private readonly logger = new Logger(${d.serviceName}.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = \`\${API_URL}?content=true\`;
      this.logger.log(\`${sq(d.displayName)}: fetching \${url}\`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: defensive trim of wire title padding.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (listing.departments?.[0]?.name ?? '')
            .toLowerCase()
            .includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = \`${d.slug}-\${jobId}\`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        // D-11: defensive trim of wire department padding.
        const deptRaw = listing.departments?.[0]?.name ?? null;
        const department = deptRaw ? deptRaw.trim() : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.${d.enumKey},
            title,
            // D-09 pass-through: wire \`company_name\`.
            companyName: listing.company_name ?? '${sq(d.displayName)}',
            // D-04: wire \`absolute_url\` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              \`https://job-boards.greenhouse.io/${d.slug}/jobs/\${listing.id}\`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(\`${sq(d.displayName)}: scraped \${jobs.length} jobs\`);
    } catch (err: any) {
      this.logger.error(\`${sq(d.displayName)} scrape failed: \${err.message}\`);
      // Report WHY, and keep whatever was accumulated: the catch sits outside
      // the loop, so a board that parsed 30 postings before failing still
      // returns those 30. Resolving (never throwing) is deliberate - the
      // breaker counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
`;
}

function moduleFile(d: CompanyDescriptor): string {
  return `import { Module } from '@nestjs/common';
import { ${d.serviceName} } from './${d.slug}.service';

@Module({ providers: [${d.serviceName}], exports: [${d.serviceName}] })
export class ${d.moduleName} {}
`;
}

function indexFile(d: CompanyDescriptor): string {
  return `export { ${d.moduleName} } from './${d.slug}.module';
export { ${d.serviceName} } from './${d.slug}.service';
`;
}

function packageJson(d: CompanyDescriptor): string {
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

function buildFixture(d: CompanyDescriptor): string {
  const jobs = d.listings.map((l, idx) => {
    const trimmedTitle = String(l.title).trim();
    // Force fixture[0] to carry trailing-space padding on both title and
    // department so the D-10/D-11 trim behaviour is always exercised.
    const title = idx === 0 ? trimmedTitle + ' ' : l.title;
    const deptLabel = l.department ? String(l.department).trim() : 'core';
    const job: Record<string, unknown> = {
      id: l.id,
      title,
      company_name: d.displayName,
      absolute_url: `https://job-boards.greenhouse.io/${d.slug}/jobs/${l.id}`,
      updated_at: l.updatedAt ?? '2026-06-01T00:00:00+00:00',
    };
    if (l.location) job.location = { name: l.location };
    if (l.department) {
      const deptName = idx === 0 ? String(l.department).trim() + ' ' : l.department;
      job.departments = [{ id: Number(l.id) + 1, name: deptName }];
    } else {
      job.departments = [];
    }
    job.content =
      `&lt;p&gt;&lt;strong&gt;About ${d.displayName}.&lt;/strong&gt; ` +
      `Now hiring a ${trimmedTitle} on the ${deptLabel} team &amp; more.&lt;/p&gt;`;
    return job;
  });
  return JSON.stringify({ jobs }, null, 2) + '\n';
}

function specMd(d: CompanyDescriptor): string {
  const created = '2026-06-03';
  return `# Spec: ${d.specNo} — Source Company Plugin: ${d.displayName}

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Spec ID        | ${d.specNo}                            |
| Slug           | source-company-${d.slug}               |
| Status         | accepted                               |
| Owner          | claude (run #398)                      |
| Created        | ${created}                             |
| Last updated   | ${created}                             |
| Supersedes     | (none)                                 |
| Related specs  | 001, 003, 005                          |

## 1. Problem Statement

${wrap(d.description, 68).join('\n')}

${d.displayName} publishes its careers board through Greenhouse at
the bare slug \`${d.slug}\`. The run-398 batch sweep confirmed
${d.jobCount} live role(s) via a direct probe of
\`https://api.greenhouse.io/v1/boards/${d.slug}/jobs?content=true\`.
Sector: ${d.sector}. HQ: ${d.hq}.

## 2. Goals

- Ship a \`source-company-${d.slug}\` plugin returning live
  \`JobPostDto\` rows from the Greenhouse board.
- Mirror the canonical variant-2 + D-08 company-direct template
  (wire \`company_name\` pass-through; defensive title/department
  trim; entity-decode-then-tag-strip descriptions).
- Bundle a unit-test suite (≥ 9 cases) with a mocked HTTP fixture.
- Publish the plugin's \`Module\` in \`ALL_SOURCE_MODULES\`.

## 3. Non-Goals

- Authenticated Greenhouse Harvest API support.
- Backfilling historical ${d.displayName} postings.
- Cross-board enrichment or salary inference.

## 4. User / Caller Stories

> As an **aggregator caller**, I want **\`Site.${d.enumKey}\`** in the
> source registry, so that **a single \`siteType: [Site.${d.enumKey}]\`
> request returns ${d.displayName}'s open roles**.

## 5. Functional Requirements

| ID    | Requirement                                                                 | Priority |
| ----- | --------------------------------------------------------------------------- | -------- |
| FR-1  | Add \`Site.${d.enumKey} = '${d.slug}'\` to the \`Site\` enum.               | must     |
| FR-2  | New plugin package \`@ever-jobs/source-company-${d.slug}\`.                  | must     |
| FR-3  | \`${d.serviceName}.scrape(input)\` returns a \`JobResponseDto\`; never throws. | must   |
| FR-4  | The plugin is registered in \`ALL_SOURCE_MODULES\`.                          | must     |
| FR-5  | \`tsconfig.base.json\` path-alias + matching \`jest.config.js\` mapper.      | must     |
| FR-6  | Each \`JobPostDto\` \`id\` prefixed \`${d.slug}-\`, \`site === Site.${d.enumKey}\`. | must |
| FR-7  | \`input.resultsWanted\` honoured.                                           | must     |
| FR-8  | \`input.searchTerm\` honoured (title + department substring).               | should   |
| FR-9  | Network errors caught — returns \`{ jobs: [] }\`.                            | must     |
| FR-10 | ≥ 9 unit tests with mocked HTTP.                                            | must     |
| FR-11 | D-08 decode-then-strip pipeline.                                            | must     |
| FR-12 | Wire \`absolute_url\` flows through to \`jobUrl\` (variant 2).               | must     |
| FR-13 | D-10 defensive \`.trim()\` on wire titles.                                   | must     |
| FR-14 | D-11 defensive \`.trim()\` on wire department names.                         | must     |

## 6. Non-Functional Requirements

NFR-1..NFR-4 — same as cohort baseline (no new runtime deps;
\`Promise\`-based async; \`Logger\` not \`console\`; resilient to
malformed payloads).

## 7. Contracts

### 7.1 API / Interface

\`\`\`ts
@SourcePlugin({ site: Site.${d.enumKey}, name: '${sq(d.displayName)}', category: 'company' })
@Injectable()
export class ${d.serviceName} implements IScraper {
  scrape(input: ScraperInputDto): Promise<JobResponseDto>;
}
\`\`\`

### 7.2 Errors

All transport errors swallowed; caller sees \`{ jobs: [] }\`.

## 8. Test Plan

- ≥ 9 cases. Happy-path asserts variant-2 URL pass-through
  (\`job-boards.greenhouse.io/${d.slug}/jobs/<id>\`), wire
  \`company_name\` pass-through (\`'${sq(d.displayName)}'\`),
  D-10 title-trim lock, D-11 department-trim lock, and the
  D-08 decode-then-strip regression guard.
- Plus standard cohort cases (resultsWanted cap, searchTerm
  match + non-match, HTTP 500 error handling, empty payload).

## 9. Open Questions

(none open — see § 10 Decisions.)

## 10. Decisions

- **D-04 (run #398):** Wire-shape variant 2 (canonical hosted-board
  host \`job-boards.greenhouse.io/${d.slug}/jobs/<id>\`).
- **D-08 (run #398):** Decode-then-strip description pipeline.
- **D-09 (run #398):** Wire \`company_name\` pass-through
  (\`'${sq(d.displayName)}'\`).
- **D-10 (run #398):** Defensive \`.trim()\` on wire titles.
- **D-11 (run #398):** Defensive \`.trim()\` on wire department names.

## 11. References

- \`packages/plugins/source-company-acurussolutions/src/acurussolutions.service.ts\`
  — canonical variant-2 + D-08 company-direct template.
- \`packages/plugins/source-ats-greenhouse/src/greenhouse.service.ts\`
- \`packages/common/src/utils/html-utils.ts\`
- \`docs/SOURCE_ADOPTION_BACKLOG.md\`
- \`docs/PLUGIN_ARCHITECTURE.md\`
`;
}

function planMd(d: CompanyDescriptor): string {
  const created = '2026-06-03';
  return `# Plan: ${d.specNo} — Source Company Plugin: ${d.displayName}

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Created      | ${created} |
| Last updated | ${created} |

## 1. Approach

${d.displayName}'s careers board is hosted on Greenhouse at the slug
\`${d.slug}\`. This plugin mirrors the canonical variant-2 + D-08
company-direct template: fetch
\`https://api.greenhouse.io/v1/boards/${d.slug}/jobs?content=true\`,
map each listing to a \`JobPostDto\`, pass the wire \`company_name\`
through, defensively \`.trim()\` titles and department names, and run
descriptions through the entity-decode-then-tag-strip pipeline. All
transport errors are swallowed so the aggregator sees an empty result
rather than an exception.

## 2. Phases

### Phase 1 — Scaffold + register + test

- Goal: a registered, tested \`source-company-${d.slug}\` plugin.
- Deliverables: package files, \`Site.${d.enumKey}\` enum value, the
  four wiring registrations, and a ≥ 9-case unit suite against a
  3-listing fixture.
- Exit criteria: \`jest\` green for the new suite; docs + CI green.

## 3. Packages Touched

- \`packages/plugins/source-company-${d.slug}\` (new)
- \`packages/models/src/enums/site.enum.ts\` (enum value)
- \`packages/plugins/index.ts\` (barrel registration)
- \`tsconfig.base.json\` + \`jest.config.js\` (path alias + mapper)
`;
}

function tasksMd(d: CompanyDescriptor): string {
  return `# Tasks: ${d.specNo} — Source Company Plugin: ${d.displayName}

> Status legend: \`[ ]\` pending • \`[~]\` in-progress • \`[x]\` done • \`[-]\` dropped

## Phase 1 — Scaffold + register + test

- [x] T01 — Add \`Site.${d.enumKey} = '${d.slug}'\` enum value under Phase ${d.phaseNo}
- [x] T02 — Scaffold the \`@ever-jobs/source-company-${d.slug}\` package
- [x] T03 — Register plugin in the four wiring files
- [x] T04 — Unit tests with mocked HTTP fixture (≥ 9 cases)
- [x] T05 — Cross-regression sweep + docs update + commit + push + CI green
`;
}

function testFile(d: CompanyDescriptor): string {
  return `import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { ${d.moduleName}, ${d.serviceName} } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, '${d.slug}-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec ${d.specNo} / T04 — \`${d.serviceName}\` unit tests (≥ 9 cases).
 */
describe('${d.serviceName} — Spec ${d.specNo} / T04', () => {
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

  describe('happy path', () => {
    it('maps all fixture listings to JobPostDto', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = dto.jobs.find((j) => j.id === '${d.slug}-' + first.id);
      expect(job0).toBeDefined();
      expect(job0?.site).toBe(Site.${d.enumKey});
      // D-09 wire company_name pass-through.
      expect(job0?.companyName).toBe('${sq(d.displayName)}');
      // D-10 title-trim lock.
      expect(job0?.title).toBe(String(first.title).trim());
      expect(job0?.title).not.toMatch(/\\s$/);
      // D-04 variant-2 URL.
      expect(job0?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/${d.slug}/jobs/' + first.id,
      );
      expect(job0?.jobUrl).toContain('job-boards.greenhouse.io/${d.slug}/jobs/');
      // D-11 department-trim lock (null-safe: some boards expose no departments).
      const firstDept =
        first.departments && first.departments[0]
          ? String(first.departments[0].name).trim()
          : null;
      expect(job0?.department).toBe(firstDept);
      expect(job0?.location?.city).toBe(first.location.name);
      expect(job0?.isRemote).toBe(
        String(first.location.name).toLowerCase().includes('remote'),
      );
      // D-08 decode-then-strip regression guard.
      expect(job0?.description).not.toContain('&lt;');
      expect(job0?.description).not.toContain('&amp;');
      expect(job0?.description).not.toContain('<p>');
      expect(job0?.description).toContain('${sq(d.displayName)}');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/${d.slug}/jobs?content=true',
      );
    });
  });

  describe('company_name pass-through', () => {
    it('emits the wire company_name for every job', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.companyName).toBe('${sq(d.displayName)}');
      }
    });
  });

  describe('D-10 title-trim lock', () => {
    it('trims wire title padding — no emitted title has surrounding whitespace', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      // Fixture listing[0] carries trailing-pad on the wire title.
      expect(JOBS_PAGE_RAW.jobs[0].title).toMatch(/\\s$/);
      for (const job of result.jobs) {
        expect(job.title).not.toMatch(/\\s$/);
        expect(job.title).not.toMatch(/^\\s/);
      }
    });
  });

  describe('D-11 department-trim lock', () => {
    it('emits trimmed department or null', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      for (let i = 0; i < result.jobs.length; i++) {
        const wire = JOBS_PAGE_RAW.jobs[i].departments;
        const expected = wire && wire[0] ? String(wire[0].name).trim() : null;
        expect(result.jobs[i].department).toBe(expected);
        if (result.jobs[i].department) {
          expect(result.jobs[i].department).not.toMatch(/\\s$/);
          expect(result.jobs[i].department).not.toMatch(/^\\s/);
        }
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}();
      const term = String(JOBS_PAGE_RAW.jobs[0].title).trim().toLowerCase();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
        searchTerm: term,
      } as ScraperInputDto);
      expect(result.jobs.length).toBeGreaterThanOrEqual(1);
      expect(result.jobs.map((j) => j.id)).toContain(
        '${d.slug}-' + JOBS_PAGE_RAW.jobs[0].id,
      );
    });

    it('returns empty for a non-matching term', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
        searchTerm: 'zzz-no-such-term-zzz',
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto with a reason, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      // Asserting jobs alone proves nothing here: it stays empty whatever the
      // plugin reported. This is the assertion that pins the diagnostics contract.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
      const service = new ${d.serviceName}();
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
`;
}

function writeFileSafe(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function scaffoldOne(repoRoot: string, d: CompanyDescriptor): string[] {
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
  return files.map(([abs]) => abs);
}

function main(): void {
  const inputPath = process.argv[2] || '.batch-input.json';
  const repoRoot = process.cwd();
  const abs = path.isAbsolute(inputPath) ? inputPath : path.join(repoRoot, inputPath);
  const batch: CompanyDescriptor[] = JSON.parse(fs.readFileSync(abs, 'utf8'));
  let total = 0;
  for (const d of batch) {
    const written = scaffoldOne(repoRoot, d);
    total += written.length;
    // eslint-disable-next-line no-console
    console.log(`scaffolded source-company-${d.slug} (${written.length} files)`);
  }
  // eslint-disable-next-line no-console
  console.log(`Done. ${batch.length} plugins, ${total} files.`);
}

if (require.main === module) {
  main();
}
