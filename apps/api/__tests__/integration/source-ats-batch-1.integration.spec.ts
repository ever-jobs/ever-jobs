/**
 * Integration test — Spec 006 / T09.
 *
 * Wires the **real** `AppModule` (full Nest bootstrap) with the only
 * external surface — `@ever-jobs/common`'s `createHttpClient` — replaced
 * by a fixture-driven router. The router decides per-URL which fixture
 * to return, so the three new ATS plugins (`avature` / `gem` / `join_com`)
 * exercise their real `scrape()` code paths against deterministic data
 * without hitting the network.
 *
 * Acceptance from `tasks.md`:
 *   "Boots `AppModule`; stubs `createHttpClient` with fixture responses
 *    for the three new plugins; calls
 *    `JobsService.searchJobs({ site: ['avature','gem','join_com'],
 *    companySlug: 'demo' })`; asserts ≥ 1 row from each plugin in the
 *    deduped result. Verifies the four-place registration (no plugin
 *    silently absent from `PluginRegistry`)."
 *
 * The test goes through `JobsAggregator` (not bare `JobsService`) so the
 * Spec 003 dedup engine is exercised end-to-end. Each plugin emits
 * `<vendor>-<id>`-prefixed ids that share no overlap on this fixture
 * corpus, so the dedup engine must keep all rows distinct (zero
 * collisions). A regression that collapsed rows across plugins would
 * fail the `≥ 1 row from each` assertion.
 *
 * The `companySlug='acme-corp'` value is load-bearing for Join.com:
 * the `JoinComService.deriveCompanyName('acme-corp')` produces
 * `'Acme Corp'` (the dash → space + title-casing path), which exactly
 * matches the Gem `jobBoardExternal.teamDisplayName='Acme Corp'`
 * baked into `gem-batch-response.json`. That alignment lets a future
 * cross-plugin dedup audit assert "same company across two plugins"
 * if/when description-bearing fixtures land — for now it just keeps
 * the assertion data tidy.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

// ── HTTP-client mock — installed BEFORE any service module is imported ────
//
// jest.mock() is hoisted to the top of the file at compile time, so the
// `createHttpClient` factory is replaced before AppModule's module-graph
// evaluation kicks off. The factory closes over the URL→fixture router
// declared below; per-test mutation of the route map is therefore safe
// because it lives in module scope, not inside `jest.mock`'s factory.
const PLUGIN_FIXTURES = (() => {
  const avatureFx = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'plugins',
    'source-ats-avature',
    '__tests__',
    'fixtures',
  );
  const gemFx = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'plugins',
    'source-ats-gem',
    '__tests__',
    'fixtures',
  );
  const joincomFx = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'plugins',
    'source-ats-joincom',
    '__tests__',
    'fixtures',
  );
  return {
    avaturePage1: fs.readFileSync(path.join(avatureFx, 'avature-page-1.html'), 'utf8'),
    avatureEmpty: fs.readFileSync(path.join(avatureFx, 'avature-page-empty.html'), 'utf8'),
    gemBatch: JSON.parse(
      fs.readFileSync(path.join(gemFx, 'gem-batch-response.json'), 'utf8'),
    ) as unknown[],
    joincomCompany: fs.readFileSync(
      path.join(joincomFx, 'joincom-company-page.html'),
      'utf8',
    ),
    joincomJobsPage1: JSON.parse(
      fs.readFileSync(path.join(joincomFx, 'joincom-jobs-page-1.json'), 'utf8'),
    ),
    joincomJobsPage2: JSON.parse(
      fs.readFileSync(path.join(joincomFx, 'joincom-jobs-page-2.json'), 'utf8'),
    ),
    joincomJobsEmpty: JSON.parse(
      fs.readFileSync(path.join(joincomFx, 'joincom-jobs-page-empty.json'), 'utf8'),
    ),
  };
})();

const httpCallLog: {
  method: 'GET' | 'POST';
  url: string;
  // GraphQL `operationName`s carried by a POST body (batched or single).
  operations?: string[];
}[] = [];

function graphqlOperations(body: unknown): string[] {
  const ops = Array.isArray(body) ? body : [body];
  return ops
    .map((op) => (op as { operationName?: unknown } | null)?.operationName)
    .filter((name): name is string => typeof name === 'string');
}

function routeGet(url: string): unknown {
  httpCallLog.push({ method: 'GET', url });

  // Avature — `https://<slug>.avature.net/careers/SearchJobs/?...`
  // First page populated; any subsequent paginated call returns empty
  // so the loop terminates.
  if (url.includes('avature.net/careers/SearchJobs/')) {
    return url.includes('jobOffset=0')
      ? PLUGIN_FIXTURES.avatureEmpty
      : PLUGIN_FIXTURES.avatureEmpty;
  }
  if (url.includes('avature.net') || url.includes('avature')) {
    // Defensive — first paginated GET against the avature subdomain.
    return PLUGIN_FIXTURES.avaturePage1;
  }

  // Join.com Step 1 — company page HTML.
  if (url.startsWith('https://join.com/companies/') && !url.includes('/api/')) {
    return PLUGIN_FIXTURES.joincomCompany;
  }

  // Join.com Step 2 — paginated jobs JSON.
  if (url.includes('/api/public/companies/') && url.includes('/jobs')) {
    if (url.includes('page=2')) return PLUGIN_FIXTURES.joincomJobsPage2;
    if (url.includes('page=1')) return PLUGIN_FIXTURES.joincomJobsPage1;
    return PLUGIN_FIXTURES.joincomJobsEmpty;
  }

  // Default — empty response. Keeps the integration suite resilient
  // against late-introduced plugins that share `siteType` enum keys
  // by returning a benign null body.
  return null;
}

function routePost(url: string, body?: unknown): unknown {
  httpCallLog.push({ method: 'POST', url, operations: graphqlOperations(body) });
  if (url.includes('jobs.gem.com/api/public/graphql/batch')) {
    return PLUGIN_FIXTURES.gemBatch;
  }
  return null;
}

// The Avature router needs to vary its return value across pages so the
// pagination loop terminates. Use a per-test counter keyed on URL.
const avatureGetCount: Map<string, number> = new Map();

function avatureRoutedGet(url: string): unknown {
  httpCallLog.push({ method: 'GET', url });
  if (!url.includes('avature.net')) return null;
  const count = (avatureGetCount.get('avature') ?? 0) + 1;
  avatureGetCount.set('avature', count);
  // First call → populated page; second+ → empty page (loop break).
  return count === 1 ? PLUGIN_FIXTURES.avaturePage1 : PLUGIN_FIXTURES.avatureEmpty;
}

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      // The Avature service goes through `get<string>(url)`.
      // The Join.com service goes through `get<string>(url)` (Step 1)
      // and `get<JoinComJobsPage>(url)` (Step 2).
      get: jest.fn(async (url: string) => {
        if (url.includes('avature.net')) {
          return { data: avatureRoutedGet(url) };
        }
        return { data: routeGet(url) };
      }),
      post: jest.fn(async (url: string, body: unknown) => {
        return { data: routePost(url, body) };
      }),
      setHeaders: jest.fn(),
    })),
  };
});

// ── Now import the app — AFTER the mock is installed ──────────────────────
// eslint-disable-next-line import/first
import { INestApplication } from '@nestjs/common';
// eslint-disable-next-line import/first
import {
  JobPostDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
// eslint-disable-next-line import/first
import { PluginRegistry } from '@ever-jobs/plugin';
// eslint-disable-next-line import/first
import { JobsAggregator } from '../../src/jobs/jobs.aggregator';
// eslint-disable-next-line import/first
import { JobsService } from '../../src/jobs/jobs.service';
// eslint-disable-next-line import/first
import { createTestApp } from '../helpers/create-app';

describe('Integration — Spec 006 / T09 (source-ats batch 1: avature × gem × join_com)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Reset routing state at suite start so the avature-page counter
    // doesn't carry stale values across describe-blocks.
    avatureGetCount.clear();
    httpCallLog.length = 0;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    avatureGetCount.clear();
    httpCallLog.length = 0;
  });

  describe('four-place registration (PluginRegistry)', () => {
    it('PluginRegistry holds Site.AVATURE / Site.GEM / Site.JOIN_COM after AppModule boots', () => {
      const registry = app.get(PluginRegistry);
      const keys = registry.listSiteKeys();
      expect(keys).toContain(Site.AVATURE);
      expect(keys).toContain(Site.GEM);
      expect(keys).toContain(Site.JOIN_COM);
    });

    it('all three new plugins are flagged as ATS sources (listAtsSites includes them)', () => {
      const registry = app.get(PluginRegistry);
      const ats = new Set(registry.listAtsSites());
      expect(ats.has(Site.AVATURE)).toBe(true);
      expect(ats.has(Site.GEM)).toBe(true);
      expect(ats.has(Site.JOIN_COM)).toBe(true);
    });

    it('each new plugin has a real IScraper bound (registry.getScraper returns truthy)', () => {
      const registry = app.get(PluginRegistry);
      expect(registry.getScraper(Site.AVATURE)).toBeDefined();
      expect(registry.getScraper(Site.GEM)).toBeDefined();
      expect(registry.getScraper(Site.JOIN_COM)).toBeDefined();
    });
  });

  describe('JobsService.searchJobs fan-out across the three plugins', () => {
    it('emits ≥ 1 row from each of the three new plugins on a single fan-out', async () => {
      const jobsService = app.get(JobsService);
      const input = new ScraperInputDto({
        siteType: [Site.AVATURE, Site.GEM, Site.JOIN_COM],
        companySlug: 'acme-corp',
        resultsWanted: 50,
      });

      const rows: JobPostDto[] = await jobsService.searchJobs(input);

      const bySite = (s: Site) => rows.filter((j) => j.site === s);
      expect(bySite(Site.AVATURE).length).toBeGreaterThan(0);
      expect(bySite(Site.GEM).length).toBeGreaterThan(0);
      expect(bySite(Site.JOIN_COM).length).toBeGreaterThan(0);

      // No row should be missing its `site` tag — the fan-out's
      // post-processing in `JobsService` stamps `site` onto every
      // row before returning. A regression that drops the tag
      // would cause the `bySite(...)` filters above to undercount.
      for (const row of rows) {
        expect(row.site).toBeDefined();
      }
    });

    it('respects resultsWanted on the per-plugin level (Avature cap fires mid-page)', async () => {
      const jobsService = app.get(JobsService);
      const input = new ScraperInputDto({
        siteType: [Site.AVATURE],
        companySlug: 'bloomberg',
        resultsWanted: 3,
      });

      const rows = await jobsService.searchJobs(input);
      expect(rows.length).toBeLessThanOrEqual(3);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.site).toBe(Site.AVATURE);
      }
    });
  });

  describe('JobsAggregator — Spec 003 dedup applied to the cross-plugin fan-out', () => {
    it('keeps every row distinct across the three plugins (zero collisions on synthetic fixtures)', async () => {
      const aggregator = app.get(JobsAggregator);
      const input = new ScraperInputDto({
        siteType: [Site.AVATURE, Site.GEM, Site.JOIN_COM],
        companySlug: 'acme-corp',
        resultsWanted: 50,
      });

      const result = await aggregator.aggregate(input, { persist: false });

      // All three plugins still contribute ≥ 1 row after dedup.
      const sites = new Set(result.jobs.map((j) => j.site));
      expect(sites.has(Site.AVATURE)).toBe(true);
      expect(sites.has(Site.GEM)).toBe(true);
      expect(sites.has(Site.JOIN_COM)).toBe(true);

      // Sanity: the dedup engine ran (envelope flag is true).
      expect(result.deduped).toBe(true);

      // Synthetic fixtures don't share canonical-key inputs across
      // plugins, so the dedup pass should be a no-op (output equals
      // input). A future fixture refactor that shares titles +
      // companies across plugins would relax this — for now the
      // strict equality is the load-bearing assertion that proves
      // dedup didn't accidentally collapse rows from different
      // plugins.
      expect(result.outputCount).toBe(result.rawCount);
    });

    it('honours dedup=false opt-out (raw fan-out unchanged, deduped flag false)', async () => {
      const aggregator = app.get(JobsAggregator);
      const input = new ScraperInputDto({
        siteType: [Site.AVATURE, Site.GEM, Site.JOIN_COM],
        companySlug: 'acme-corp',
        resultsWanted: 50,
      });

      const result = await aggregator.aggregate(input, {
        dedup: false,
        persist: false,
      });
      expect(result.deduped).toBe(false);
      expect(result.outputCount).toBe(result.rawCount);
      expect(result.jobs.length).toBeGreaterThan(0);
    });
  });

  describe('HTTP-client mock — wire-call shape', () => {
    // Since Spec 5035 (eb0528dd, detail overlay for body/date/pay) Gem sends
    // ONE batched list POST (JobBoardTheme + JobBoardList) and then ONE
    // `ExternalJobPostingQuery` detail POST per kept posting, all to the same
    // batch endpoint. This case was written against the list-only plugin and
    // still expected a single POST (Spec 1689 updated it); it now pins both
    // halves of the new shape instead of a bare total.
    it('Gem issues ONE list POST plus one detail POST per kept posting (Spec 5035)', async () => {
      const jobsService = app.get(JobsService);
      const input = new ScraperInputDto({
        siteType: [Site.GEM],
        companySlug: 'acme-corp',
        resultsWanted: 50,
      });
      const rows = await jobsService.searchJobs(input);
      const gemRows = rows.filter((j) => j.site === Site.GEM);

      const gemPosts = httpCallLog.filter(
        (c) =>
          c.method === 'POST' &&
          c.url.includes('jobs.gem.com/api/public/graphql/batch'),
      );
      const listPosts = gemPosts.filter((c) =>
        c.operations?.includes('JobBoardList'),
      );
      const detailPosts = gemPosts.filter((c) =>
        c.operations?.includes('ExternalJobPostingQuery'),
      );

      // The fixture carries 3 postings, each with an extId and a title, and
      // resultsWanted=50 keeps them all — so 3 detail fetches, 4 POSTs total.
      expect(gemRows).toHaveLength(3);
      expect(listPosts).toHaveLength(1);
      expect(detailPosts).toHaveLength(gemRows.length);
      expect(gemPosts).toHaveLength(1 + gemRows.length);
      // The list call is the first one out; details only follow it.
      expect(gemPosts[0].operations).toContain('JobBoardList');
    });

    it('Join.com issues a Step-1 HTML GET before the Step-2 JSON GETs', async () => {
      const jobsService = app.get(JobsService);
      const input = new ScraperInputDto({
        siteType: [Site.JOIN_COM],
        companySlug: 'acme-corp',
        resultsWanted: 50,
      });
      await jobsService.searchJobs(input);

      const joincomCalls = httpCallLog.filter(
        (c) => c.method === 'GET' && c.url.includes('join.com'),
      );
      expect(joincomCalls.length).toBeGreaterThanOrEqual(2);
      expect(joincomCalls[0].url).toContain('/companies/acme-corp');
      expect(joincomCalls[0].url).not.toContain('/api/public/');
      // At least one subsequent call hits the paginated jobs endpoint.
      expect(
        joincomCalls.some((c) => c.url.includes('/api/public/companies/')),
      ).toBe(true);
    });
  });
});
