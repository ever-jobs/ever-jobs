import 'reflect-metadata';
import { EventEmitter } from 'events';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { StreamableFile } from '@nestjs/common';
import { resetCrawlPolicyEnvCache, resetEffectiveCrawlPolicyCache, resetHostLimiter } from '@ever-jobs/common';
import { JOB_LIVENESS_REASON_LISTED, JobPostDto, ScraperInputDto, Site } from '@ever-jobs/models';
import { SoftyService } from '@ever-jobs/source-ats-softy';
import { LIVENESS_TRUST_LISTED_MAX_AGE_ENV, resetSwitchWarnings } from '../crawl-policy.mapping';
import { JobsController } from '../jobs.controller';
import { SEARCH_CACHE_ENDPOINT } from '../search-cache';
import { COMPLETE_SEARCH } from '../search-completeness';

/**
 * Spec 1715 review round 2 — `descriptionDepth: 'board'` keeps the listing (D5: one
 * list page carries up to 21 offers, fewer requests than the sitemap plus a detail
 * page per offer). With `?liveness=true` that premise used to fail: board posts
 * carried neither `jobUrlFetchedAt` nor `jobUrlListedAt`, so the controller probed
 * every card's `/offers/{id}` under `domain:softy.pro` right after the list page that
 * had just listed it — on every repeat of the search, search-cache hits included.
 *
 * Now every listing-path post carries `jobUrlListedAt` (when its list page answered;
 * list pages are never cached), so the controller trusts it within
 * `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` and sends no probe.
 *
 * End to end without the network: the REAL `SoftyService` (its only seam,
 * `tenantOrigin`, points at a loopback server; the real `HttpClient`, resolver and
 * limiter; the loopback host let through the egress guard by its documented
 * allow-list) feeds the REAL `JobsController` liveness enrichment; only the fan-out,
 * the aggregator, the search cache and the liveness checker are stand-ins.
 *
 * Red controls: `SOFTY_LEGACY=listing-no-listed-at` (the pre-fix plugin) and
 * `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0` — every card is probed again.
 */

class LoopbackSofty extends SoftyService {
  constructor(private readonly originOf: () => string) {
    super();
  }

  protected tenantOrigin(): string {
    return this.originOf();
  }
}

const IDS = [3001, 3002, 3003];

function listingOf(ids: number[]): string {
  const cards = ids
    .map(
      (id) => `<a href="/offers/${id}"><div data-slot="card"><h3 data-slot="joboffer-title">Offre ${id}</h3>
        <div data-slot="joboffer-locations"><p>Dijon</p></div><span data-slot="badge">CDI</span></div></a>`,
    )
    .join('\n');
  return `<!DOCTYPE html><html><body><main>${cards}</main></body></html>`;
}

class FakeResponse extends EventEmitter {
  setHeader(): void {
    /* headers are covered by jobs.controller.ndjson.spec.ts */
  }
}

async function readAll(file: StreamableFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

const ENV_PATTERN = /^(EVER_JOBS_CRAWL_|EVER_JOBS_LIVENESS_|SOFTY_)/;
const PROXY_KEYS = ['DEFAULT_PROXIES', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

type Format = 'json' | 'ndjson';

describe('JobsController ?liveness=true × Softy board depth (Spec 1715 review round 2)', () => {
  let server: Server;
  let origin = '';
  let hits: string[] = [];
  let savedEnv: Record<string, string | undefined> = {};
  const service = new LoopbackSofty(() => origin);

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/offers?page=1') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(listingOf(IDS));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    savedEnv = {};
    for (const key of [...Object.keys(process.env).filter((k) => ENV_PATTERN.test(k)), ...PROXY_KEYS]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS = '127.0.0.1';
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
    resetSwitchWarnings();
    service.clearCaches();
    hits = [];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env).filter((k) => ENV_PATTERN.test(k))) delete process.env[key];
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
    resetSwitchWarnings();
  });

  /** A controller whose fan-out is one real Softy board scrape; `cached` answers as a search-cache hit. */
  function createController(cached?: JobPostDto[]) {
    const probed: string[][] = [];
    const liveness = {
      check: jest.fn(),
      checkBatch: jest.fn(async (urls: string[]) => {
        probed.push(urls);
        return urls.map((url) => ({ url, result: 'active' as const, code: 'ok', checkedAt: '2026-09-27T00:00:00Z' }));
      }),
    };
    const produced: JobPostDto[][] = [];
    const jobsService = {
      assertSearchable: jest.fn(),
      searchJobsWithDiagnostics: jest.fn(async () => {
        const res = await service.scrape(
          new ScraperInputDto({
            siteType: [Site.SOFTY],
            companySlug: 'acme',
            descriptionDepth: 'board',
            resultsWanted: IDS.length,
          } as Partial<ScraperInputDto>),
        );
        produced.push(res.jobs);
        return { jobs: res.jobs, perSource: [], completeness: { ...COMPLETE_SEARCH } };
      }),
    };
    const aggregator = {
      aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({ jobs: raw, rawCount: raw.length, outputCount: raw.length, deduped: false })),
    };
    const cacheService = {
      get: jest.fn(async (params: { endpoint?: string }) =>
        params.endpoint === SEARCH_CACHE_ENDPOINT && cached ? { jobs: cached, completeness: { ...COMPLETE_SEARCH } } : null,
      ),
      set: jest.fn(async () => undefined),
    };
    const controller = new JobsController(
      jobsService as any,
      aggregator as any,
      {} as any,
      cacheService as any,
      { get: (_key: string, def?: unknown) => def } as any,
      liveness as any,
    );
    jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);
    return { controller, probed, produced };
  }

  async function searchWithLiveness(controller: JobsController, format: Format): Promise<JobPostDto[]> {
    const input = new ScraperInputDto({ searchTerm: 'x' });
    if (format === 'json') {
      const result = (await controller.searchJobs(input, undefined, undefined, undefined, undefined, undefined, 'true')) as {
        jobs: JobPostDto[];
      };
      return result.jobs;
    }
    const file = (await controller.searchJobs(
      input,
      'ndjson',
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
      undefined,
      new FakeResponse() as any,
    )) as StreamableFile;
    const lines = (await readAll(file))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; data?: JobPostDto; message?: string });
    const error = lines.find((l) => l.type === 'error');
    if (error) throw new Error(`NDJSON error line: ${error.message}`);
    return lines.filter((l) => l.type === 'job').map((l) => l.data!);
  }

  it.each<Format>(['json', 'ndjson'])(
    '%s: one list page, then no liveness probe — every board card is trusted as listed',
    async (format) => {
      const { controller, probed } = createController();

      const jobs = await searchWithLiveness(controller, format);

      expect(hits).toEqual(['/offers?page=1']); // board depth: the listing only (D5)
      expect(jobs.map((j) => j.atsId)).toEqual(IDS.map(String));
      expect(probed).toEqual([]);
      for (const job of jobs) {
        expect(job.jobUrlListedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(job.liveness).toEqual({ state: 'active', checkedAt: job.jobUrlListedAt, reason: JOB_LIVENESS_REASON_LISTED });
      }
    },
    15_000,
  );

  it('a repeat served from the search cache within the window sends no probe either', async () => {
    const first = createController();
    const jobs = await searchWithLiveness(first.controller, 'json');
    const cachedCopy = jobs.map((job) => new JobPostDto({ ...job, liveness: undefined }));
    hits = [];

    const { controller, probed } = createController(cachedCopy);
    const again = await searchWithLiveness(controller, 'json');

    expect(hits).toEqual([]); // nothing reached the tenant
    expect(probed).toEqual([]);
    for (const job of again) expect(job.liveness?.reason).toBe(JOB_LIVENESS_REASON_LISTED);
  }, 15_000);

  it('red control: SOFTY_LEGACY=listing-no-listed-at — every card is probed (the pre-fix traffic)', async () => {
    process.env.SOFTY_LEGACY = 'listing-no-listed-at';
    const { controller, probed } = createController();

    const jobs = await searchWithLiveness(controller, 'json');

    expect(jobs.every((j) => j.jobUrlListedAt === undefined)).toBe(true);
    expect(probed).toEqual([IDS.map((id) => `${origin}/offers/${id}`)]);
  }, 15_000);

  it(`red control: ${LIVENESS_TRUST_LISTED_MAX_AGE_ENV}=0 — the controller probes every card again`, async () => {
    process.env[LIVENESS_TRUST_LISTED_MAX_AGE_ENV] = '0';
    const { controller, probed } = createController();

    const jobs = await searchWithLiveness(controller, 'json');

    expect(jobs.every((j) => typeof j.jobUrlListedAt === 'string')).toBe(true);
    expect(probed).toEqual([IDS.map((id) => `${origin}/offers/${id}`)]);
  }, 15_000);
});
