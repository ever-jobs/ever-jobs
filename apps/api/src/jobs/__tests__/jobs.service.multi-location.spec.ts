import 'reflect-metadata';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  HTTP_MEMO_ENV,
  HostCoolingDownError,
  createHttpClient,
  getScrapeContext,
  resetCrawlPolicyEnvCache,
  resetEffectiveCrawlPolicyCache,
  resetHostLimiter,
} from '@ever-jobs/common';
import {
  ERR_SOURCE_CIRCUIT_OPEN,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
  SourceDiagnosticDto,
} from '@ever-jobs/models';
import {
  DEFAULT_SEARCH_LOCATION_INTERVAL_MS,
  JobsService,
  LocatedSourceDiagnosticDto,
  MAX_PLUGIN_REQUEST_INTERVAL_MS,
  MAX_SEARCH_LOCATION_INTERVAL_MS,
  SEARCH_LOCATION_INTERVAL_ENV,
  SEARCH_MAX_LOCATIONS_ENV,
  clampLocationInterval,
  locationPauseMs,
  readMaxSearchLocations,
} from '../jobs.service';
import {
  AUSTIN,
  CHICAGO,
  NEW_YORK,
  OVERLAP_ID,
  chicagoJobs,
  newYorkJobs,
} from './fixtures/multi-location.fixture';

/**
 * Spec 1700 — multi-location fan-out in `JobsService.searchJobsWithDiagnostics`.
 * Same `Object.create` harness as jobs.service.spec.ts, kept in its own file.
 */

type ScrapeImpl = (input: ScraperInputDto) => Promise<JobResponseDto>;

interface Harness {
  service: JobsService;
  inc: jest.Mock;
  warn: jest.Mock;
  log: jest.Mock;
}

const ATS = new Set<Site>([Site.GREENHOUSE, Site.LEVER]);

function createService(
  entries: [Site, IScraper][],
  overrides: {
    config?: Record<string, unknown>;
    deadlineMs?: number;
    circuitBreaker?: { wrap: (site: Site, fn: () => Promise<JobResponseDto>) => Promise<JobResponseDto> };
    metadata?: Partial<Record<Site, { minRequestIntervalMs?: number }>>;
  } = {},
): Harness {
  const map = new Map(entries);
  const service: any = Object.create(JobsService.prototype);
  const log = jest.fn();
  const warn = jest.fn();
  service.logger = { log, warn, error: jest.fn(), debug: jest.fn() };
  service.registry = {
    size: map.size,
    siteForDomain: () => undefined,
    getScraper: (site: Site) => map.get(site),
    listSiteKeys: () => [...map.keys()],
    listAtsSites: () => [...map.keys()].filter((s) => ATS.has(s)),
    listSources: () => [],
    getMetadata: (site: Site) => overrides.metadata?.[site],
  };
  const config: Record<string, unknown> = {
    'search.concurrency': 64,
    'search.deadlineMs': overrides.deadlineMs ?? 0,
    // No politeness pause unless a case opts in, so the suite stays fast.
    'search.locationIntervalMs': 0,
    ...overrides.config,
  };
  service.configService = {
    get: (key: string, def?: unknown) => {
      if (key === 'retry') {
        return { defaultRetries: 0, defaultDelayMs: 0, defaultBackoff: 'linear', perSource: {} };
      }
      return key in config ? config[key] : def;
    },
  };
  const inc = jest.fn();
  service.metrics = {
    scraperDuration: { startTimer: () => () => undefined },
    scraperRequestsTotal: { inc },
  };
  if (overrides.circuitBreaker) service.circuitBreaker = overrides.circuitBreaker;
  return { service: service as JobsService, inc, warn, log };
}

/** A scraper whose response depends on the location it is asked for. */
function byLocation(table: Record<string, () => JobPostDto[]>): IScraper & { scrape: jest.Mock } {
  return {
    scrape: jest.fn(async (input: ScraperInputDto) => new JobResponseDto(table[input.location ?? '']?.() ?? [])),
  };
}

function scraperOf(impl: ScrapeImpl): IScraper & { scrape: jest.Mock } {
  return { scrape: jest.fn(impl) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowsFor(perSource: SourceDiagnosticDto[], site: string): LocatedSourceDiagnosticDto[] {
  return perSource.filter((r) => r.site === site) as LocatedSourceDiagnosticDto[];
}

function axiosLike(status: number): Error & { response: { status: number } } {
  const err = new Error(`Request failed with status code ${status}`) as Error & { response: { status: number } };
  err.response = { status };
  return err;
}

describe('JobsService — multi-location search (Spec 1700)', () => {
  describe('single-location callers are untouched', () => {
    it('without `locations` the scraper gets the caller input once, with no list key', async () => {
      const scraper = byLocation({ [AUSTIN]: newYorkJobs });
      const { service } = createService([[Site.THEMUSE, scraper]]);
      const input = new ScraperInputDto({ siteType: [Site.THEMUSE], location: AUSTIN, searchTerm: 'engineer' });

      const out = await service.searchJobsWithDiagnostics(input);

      expect(scraper.scrape).toHaveBeenCalledTimes(1);
      const sent = scraper.scrape.mock.calls[0][0] as ScraperInputDto;
      expect(sent.location).toBe(AUSTIN);
      expect('locations' in sent).toBe(false);
      expect(out.jobs).toHaveLength(3);
      expect(out.perSource).toEqual([new SourceDiagnosticDto(Site.THEMUSE, 3, 'ok')]);
      expect(out.perSource[0]).not.toHaveProperty('location');
    });

    it('`locations: [one]` collapses to the single path', async () => {
      const scraper = byLocation({ NYC: newYorkJobs });
      const { service } = createService([[Site.THEMUSE, scraper]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: ['  NYC '] }),
      );

      expect(scraper.scrape).toHaveBeenCalledTimes(1);
      const sent = scraper.scrape.mock.calls[0][0] as ScraperInputDto;
      expect(sent.location).toBe('NYC');
      expect(sent.locations).toBeUndefined();
      expect(out.perSource[0]).not.toHaveProperty('location');
    });

    it('`location` equal to the only list entry is searched once', async () => {
      const scraper = byLocation({ NYC: newYorkJobs });
      const { service } = createService([[Site.THEMUSE, scraper]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], location: 'NYC', locations: ['nyc'] }),
      );

      expect(scraper.scrape).toHaveBeenCalledTimes(1);
    });

    it('an empty or all-blank list keeps the caller location', async () => {
      const scraper = byLocation({ [AUSTIN]: newYorkJobs });
      const { service } = createService([[Site.THEMUSE, scraper]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], location: AUSTIN, locations: ['  ', ''] }),
      );

      expect(scraper.scrape).toHaveBeenCalledTimes(1);
      expect(scraper.scrape.mock.calls[0][0].location).toBe(AUSTIN);
      expect(scraper.scrape.mock.calls[0][0].locations).toBeUndefined();
    });
  });

  describe('fan-out', () => {
    it('calls every site once per location, in order, with a plain single location', async () => {
      const muse = byLocation({ [NEW_YORK]: newYorkJobs, [CHICAGO]: chicagoJobs });
      const dice = byLocation({});
      const { service } = createService([[Site.THEMUSE, muse], [Site.DICE, dice]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE, Site.DICE], locations: [NEW_YORK, CHICAGO] }),
      );

      for (const s of [muse, dice]) {
        expect(s.scrape.mock.calls.map((c) => c[0].location)).toEqual([NEW_YORK, CHICAGO]);
        for (const [sent] of s.scrape.mock.calls) expect(sent.locations).toBeUndefined();
      }
    });

    it('searches `location` first, then the list', async () => {
      const muse = byLocation({});
      const { service } = createService([[Site.THEMUSE, muse]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], location: AUSTIN, locations: [NEW_YORK, CHICAGO] }),
      );

      expect(muse.scrape.mock.calls.map((c) => c[0].location)).toEqual([AUSTIN, NEW_YORK, CHICAGO]);
    });

    it('gives every location the caller offset and resultsWanted — no shared cursor or budget', async () => {
      const seven = () => Array.from({ length: 7 }, (_, i) => new JobPostDto({ id: `n${i}`, title: 't', companyName: 'Acme', jobUrl: `https://x/${i}` }));
      const muse = byLocation({ [NEW_YORK]: seven, [CHICAGO]: chicagoJobs });
      const { service } = createService([[Site.THEMUSE, muse]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({
          siteType: [Site.THEMUSE],
          locations: [NEW_YORK, CHICAGO],
          offset: 30,
          resultsWanted: 7,
        }),
      );

      for (const [sent] of muse.scrape.mock.calls) {
        expect(sent.offset).toBe(30);
        expect(sent.resultsWanted).toBe(7);
      }
    });

    it('is sequential per site and parallel across sites', async () => {
      const perSitePeak = new Map<string, number>();
      const inFlight = new Map<string, number>();
      let global = 0;
      let globalPeak = 0;
      const tracking = (site: string) =>
        scraperOf(async () => {
          inFlight.set(site, (inFlight.get(site) ?? 0) + 1);
          global++;
          perSitePeak.set(site, Math.max(perSitePeak.get(site) ?? 0, inFlight.get(site)!));
          globalPeak = Math.max(globalPeak, global);
          await sleep(15);
          inFlight.set(site, inFlight.get(site)! - 1);
          global--;
          return new JobResponseDto([]);
        });
      const sites = [Site.THEMUSE, Site.DICE, Site.MONSTER];
      const { service } = createService(sites.map((s) => [s, tracking(s)] as [Site, IScraper]));

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: sites, locations: [NEW_YORK, CHICAGO, AUSTIN] }),
      );

      for (const s of sites) expect(perSitePeak.get(s)).toBe(1);
      expect(globalPeak).toBeGreaterThan(1);
    });

    it('emits one diagnostic row per (site, location) with the bare site key', async () => {
      const muse = byLocation({ [NEW_YORK]: newYorkJobs });
      const { service } = createService([[Site.THEMUSE, muse]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(out.perSource).toEqual([
        new LocatedSourceDiagnosticDto(Site.THEMUSE, 3, 'ok', undefined, NEW_YORK),
        new LocatedSourceDiagnosticDto(Site.THEMUSE, 0, 'empty', undefined, CHICAGO),
      ]);
      expect(JSON.parse(JSON.stringify(out.perSource[0]))).toEqual({
        site: Site.THEMUSE,
        count: 3,
        reason: 'ok',
        location: NEW_YORK,
      });
    });
  });

  describe('failure isolation and the polite stop', () => {
    it('one failing location keeps the others and the other sites', async () => {
      const muse = scraperOf(async (input) => {
        if (input.location === CHICAGO) throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return new JobResponseDto(newYorkJobs());
      });
      const dice = byLocation({ [NEW_YORK]: newYorkJobs, [CHICAGO]: chicagoJobs });
      const { service } = createService([[Site.THEMUSE, muse], [Site.DICE, dice]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE, Site.DICE], locations: [NEW_YORK, CHICAGO] }),
      );

      const muses = rowsFor(out.perSource, Site.THEMUSE);
      expect(muses.map((r) => [r.location, r.reason, r.count])).toEqual([
        [NEW_YORK, 'ok', 3],
        [CHICAGO, 'timeout', 0],
      ]);
      expect(rowsFor(out.perSource, Site.DICE).map((r) => r.reason)).toEqual(['ok', 'ok']);
      expect(out.jobs.filter((j) => j.site === Site.THEMUSE)).toHaveLength(3);
      expect(out.jobs.filter((j) => j.site === Site.DICE)).toHaveLength(5);
    });

    it('stops asking a site after a 429 and reports the rest as not attempted', async () => {
      const muse = scraperOf(async () => {
        throw axiosLike(429);
      });
      const { service, inc } = createService([[Site.THEMUSE, muse]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
      );

      expect(muse.scrape).toHaveBeenCalledTimes(1);
      const rows = rowsFor(out.perSource, Site.THEMUSE);
      expect(rows.map((r) => [r.location, r.reason])).toEqual([
        [NEW_YORK, 'fetch_error'],
        [CHICAGO, 'fetch_error'],
        [AUSTIN, 'fetch_error'],
      ]);
      expect(rows[1].detail).toBe(`not attempted: ${Site.THEMUSE} refused the search for "${NEW_YORK}"`);
      const skippedCalls = inc.mock.calls.filter(([labels]) => labels.status === 'location_skipped');
      expect(skippedCalls).toHaveLength(2);
    });

    it('stops after a 403 thrown by the plugin', async () => {
      const muse = scraperOf(async () => {
        throw axiosLike(403);
      });
      const { service } = createService([[Site.THEMUSE, muse]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(muse.scrape).toHaveBeenCalledTimes(1);
      expect(rowsFor(out.perSource, Site.THEMUSE).map((r) => r.reason)).toEqual(['blocked', 'blocked']);
    });

    it('stops after a swallowed block reported as a diagnostic', async () => {
      const muse = scraperOf(async () => new JobResponseDto([], new ScrapeDiagnostics('blocked', 'challenge page')));
      const { service } = createService([[Site.THEMUSE, muse]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
      );

      expect(muse.scrape).toHaveBeenCalledTimes(1);
    });

    it('stops after a swallowed rate limit reported as fetch_error', async () => {
      const muse = scraperOf(
        async () => new JobResponseDto([], new ScrapeDiagnostics('fetch_error', 'HTTP 429 Too Many Requests')),
      );
      const { service } = createService([[Site.THEMUSE, muse]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(muse.scrape).toHaveBeenCalledTimes(1);
    });

    it('does not stop on a non-refusal (404, 5xx, empty)', async () => {
      const notFound = scraperOf(async () => {
        throw axiosLike(404);
      });
      const serverError = scraperOf(
        async () => new JobResponseDto([], new ScrapeDiagnostics('fetch_error', 'HTTP 503')),
      );
      const { service } = createService([[Site.THEMUSE, notFound], [Site.DICE, serverError]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE, Site.DICE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(notFound.scrape).toHaveBeenCalledTimes(2);
      expect(serverError.scrape).toHaveBeenCalledTimes(2);
      expect(rowsFor(out.perSource, Site.THEMUSE).map((r) => r.reason)).toEqual(['bad_input', 'bad_input']);
    });

    it('an open circuit breaker gives one circuit_open row, then not-attempted rows', async () => {
      const muse = byLocation({});
      const breakerErr = Object.assign(new Error('circuit open'), { code: ERR_SOURCE_CIRCUIT_OPEN });
      const { service } = createService([[Site.THEMUSE, muse]], {
        circuitBreaker: { wrap: jest.fn().mockRejectedValue(breakerErr) },
      });

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
      );

      const rows = rowsFor(out.perSource, Site.THEMUSE);
      expect(rows.map((r) => r.reason)).toEqual(['circuit_open', 'circuit_open', 'circuit_open']);
      expect(rows[0].detail).toBe(`circuit open for ${Site.THEMUSE}`);
      expect(rows[1].detail).toMatch(/^not attempted: /);
      expect(rows[2].detail).toMatch(/^not attempted: /);
    });
  });

  describe('identity dedup across locations', () => {
    it('removes the same posting returned for two locations', async () => {
      const muse = byLocation({ [NEW_YORK]: newYorkJobs, [CHICAGO]: chicagoJobs });
      const { service } = createService([[Site.THEMUSE, muse]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(out.jobs).toHaveLength(5);
      expect(out.jobs.filter((j) => j.id === OVERLAP_ID)).toHaveLength(1);
      // Diagnostics keep the raw per-location counts.
      expect(rowsFor(out.perSource, Site.THEMUSE).map((r) => r.count)).toEqual([3, 3]);
    });

    it('keeps the same id from two different sites', async () => {
      const muse = byLocation({ [NEW_YORK]: newYorkJobs, [CHICAGO]: chicagoJobs });
      const dice = byLocation({ [NEW_YORK]: newYorkJobs, [CHICAGO]: chicagoJobs });
      const { service } = createService([[Site.THEMUSE, muse], [Site.DICE, dice]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE, Site.DICE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(out.jobs.filter((j) => j.id === OVERLAP_ID)).toHaveLength(2);
      expect(out.jobs).toHaveLength(10);
    });

    it('falls back to jobUrl without an id, and keeps jobs with neither', async () => {
      const noId = () => [
        new JobPostDto({ title: 'A', companyName: 'Acme', jobUrl: 'https://x/a' }),
        new JobPostDto({ title: 'B', companyName: 'Acme', jobUrl: '' }),
      ];
      const muse = byLocation({ [NEW_YORK]: noId, [CHICAGO]: noId });
      const { service } = createService([[Site.THEMUSE, muse]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(out.jobs.map((j) => j.title).sort()).toEqual(['A', 'B', 'B']);
    });

    it('keeps two postings that share an index-derived id but not a URL', async () => {
      const make = (loc: string) => () => [
        new JobPostDto({ id: 'board-0', title: `First in ${loc}`, companyName: 'Acme', jobUrl: `https://x/${loc}` }),
      ];
      const muse = byLocation({ [NEW_YORK]: make('ny'), [CHICAGO]: make('chi') });
      const { service } = createService([[Site.THEMUSE, muse]]);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(out.jobs).toHaveLength(2);
    });
  });

  describe('deadline', () => {
    it('reports locations past the deadline as timeout and keeps finished work', async () => {
      const muse = scraperOf(async (input) => {
        if (input.location === NEW_YORK) return new JobResponseDto(newYorkJobs());
        return new Promise<JobResponseDto>(() => undefined); // never settles
      });
      const { service, warn } = createService([[Site.THEMUSE, muse]], { deadlineMs: 80 });

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
      );

      const rows = rowsFor(out.perSource, Site.THEMUSE);
      expect(rows.map((r) => [r.location, r.reason])).toEqual([
        [NEW_YORK, 'ok'],
        [CHICAGO, 'timeout'],
        [AUSTIN, 'timeout'],
      ]);
      expect(out.jobs).toHaveLength(3);
      expect(muse.scrape).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('(source, location) calls'));
    });
  });

  describe('the location cap', () => {
    it('searches at most search.maxLocations and reports the rest as bad_input', async () => {
      const muse = byLocation({});
      const { service } = createService([[Site.THEMUSE, muse]], { config: { 'search.maxLocations': 10 } });
      const twelve = Array.from({ length: 12 }, (_, i) => `City ${i + 1}`);

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: twelve }),
      );

      expect(muse.scrape).toHaveBeenCalledTimes(10);
      const dropped = out.perSource.filter((r) => r.site.startsWith('location:'));
      expect(dropped).toEqual([
        new SourceDiagnosticDto('location:City 11', 0, 'bad_input', 'dropped: over the 10-location cap'),
        new SourceDiagnosticDto('location:City 12', 0, 'bad_input', 'dropped: over the 10-location cap'),
      ]);
    });

    it('reads the env var when no config key is set', async () => {
      const muse = byLocation({});
      const { service } = createService([[Site.THEMUSE, muse]], { config: { [SEARCH_MAX_LOCATIONS_ENV]: '2' } });

      const out = await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: ['A', 'B', 'C'] }),
      );

      expect(muse.scrape).toHaveBeenCalledTimes(2);
      expect(out.perSource.filter((r) => r.site === 'location:C')).toHaveLength(1);
    });
  });

  describe('routing', () => {
    it('companySlug without siteType still runs ATS sites only, once per location', async () => {
      const greenhouse = byLocation({});
      const muse = byLocation({});
      const { service } = createService([[Site.GREENHOUSE, greenhouse], [Site.THEMUSE, muse]]);

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ companySlug: 'acme', locations: [NEW_YORK, CHICAGO] }),
      );

      expect(greenhouse.scrape).toHaveBeenCalledTimes(2);
      expect(muse.scrape).not.toHaveBeenCalled();
    });
  });

  describe('politeness pause', () => {
    it('spaces one site’s location calls by search.locationIntervalMs', async () => {
      const starts: number[] = [];
      const ends: number[] = [];
      const muse = scraperOf(async () => {
        starts.push(Date.now());
        ends.push(Date.now());
        return new JobResponseDto([]);
      });
      const { service } = createService([[Site.THEMUSE, muse]], { config: { 'search.locationIntervalMs': 60 } });

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(starts).toHaveLength(2);
      // Timer granularity allows a couple of ms of slack.
      expect(starts[1] - ends[0]).toBeGreaterThanOrEqual(55);
    });

    it('falls back to EVER_JOBS_SEARCH_LOCATION_INTERVAL_MS when the config key is absent', async () => {
      const starts: number[] = [];
      const muse = scraperOf(async () => {
        starts.push(Date.now());
        return new JobResponseDto([]);
      });
      const { service } = createService([[Site.THEMUSE, muse]], {
        config: { 'search.locationIntervalMs': undefined, [SEARCH_LOCATION_INTERVAL_ENV]: '60' },
      });

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(starts).toHaveLength(2);
      expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(55);
    });

    it('waits at least the plugin’s declared request gap, even with the interval at 0', async () => {
      const starts: Record<string, number[]> = { muse: [], linkedin: [] };
      const muse = scraperOf(async () => {
        starts.muse.push(Date.now());
        return new JobResponseDto([]);
      });
      const linkedin = scraperOf(async () => {
        starts.linkedin.push(Date.now());
        return new JobResponseDto([]);
      });
      const { service } = createService(
        [
          [Site.THEMUSE, muse],
          [Site.LINKEDIN, linkedin],
        ],
        { metadata: { [Site.LINKEDIN]: { minRequestIntervalMs: 80 } } },
      );

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE, Site.LINKEDIN], locations: [NEW_YORK, CHICAGO] }),
      );

      expect(starts.linkedin[1] - starts.linkedin[0]).toBeGreaterThanOrEqual(75);
      expect(starts.muse[1] - starts.muse[0]).toBeLessThan(75);
    });

    it('does not pause after a location that was not attempted', async () => {
      const muse = scraperOf(async () => {
        throw axiosLike(429);
      });
      const { service } = createService([[Site.THEMUSE, muse]], { config: { 'search.locationIntervalMs': 5_000 } });
      const started = Date.now();

      await service.searchJobsWithDiagnostics(
        new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
      );

      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});

describe('JobsService — multi-location response memo (Spec 1700, T13)', () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];
  const savedMemo = process.env[HTTP_MEMO_ENV];
  /**
   * The local test server, exempt from the crawl policy's egress guard (Spec
   * 1690 §4.8) for these clients only — the guard itself stays on.
   */
  const LOOPBACK = ['127.0.0.1'];
  const client = () => createHttpClient({ retries: 0, timeout: 5, egressAllowHosts: LOOPBACK });

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 'a', city: NEW_YORK }, { id: 'b', city: CHICAGO }]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    hits.length = 0;
    delete process.env[HTTP_MEMO_ENV];
    // Spec 1690: fresh crawl-policy state, so pacing from one case never delays the next.
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
  });
  afterEach(() => {
    if (savedMemo === undefined) delete process.env[HTTP_MEMO_ENV];
    else process.env[HTTP_MEMO_ENV] = savedMemo;
  });

  /** A company-board plugin: fetches the whole board, filters by location locally. */
  const boardPlugin = () =>
    scraperOf(async (input) => {
      const res = await client().get(`${base}/board`);
      const rows = (res.data as { id: string; city: string }[]).filter((r) => r.city === input.location);
      return new JobResponseDto(
        rows.map((r) => new JobPostDto({ id: r.id, title: 'Engineer', jobUrl: `https://x.test/${r.id}` })),
      );
    });

  it('fetches a whole-board source once for N locations and keeps each location’s rows', async () => {
    const board = boardPlugin();
    const { service } = createService([[Site.GREENHOUSE, board]]);

    const out = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.GREENHOUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
    );

    expect(board.scrape).toHaveBeenCalledTimes(3);
    expect(hits).toEqual(['/board']);
    expect(out.jobs.map((j) => j.id).sort()).toEqual(['a', 'b']);
    expect(rowsFor(out.perSource, Site.GREENHOUSE).map((r) => r.count)).toEqual([1, 1, 0]);
  });

  it('still sends one request per location for a source that searches by location', async () => {
    const search = scraperOf(async (input) => {
      await client().get(`${base}/search`, { params: { l: input.location } });
      return new JobResponseDto([]);
    });
    const { service } = createService([[Site.THEMUSE, search]]);

    await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
    );

    expect(hits).toHaveLength(2);
  });

  it('never shares a response between two sources', async () => {
    const { service } = createService([
      [Site.GREENHOUSE, boardPlugin()],
      [Site.LEVER, boardPlugin()],
    ]);

    await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.GREENHOUSE, Site.LEVER], locations: [NEW_YORK, CHICAGO] }),
    );

    expect(hits).toEqual(['/board', '/board']);
  });

  it(`${HTTP_MEMO_ENV}=off fetches the board once per location, as before`, async () => {
    process.env[HTTP_MEMO_ENV] = 'off';
    const { service } = createService([[Site.GREENHOUSE, boardPlugin()]]);

    await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.GREENHOUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
    );

    expect(hits).toHaveLength(3);
  });

  it('a single-location search never opens a memo', async () => {
    const board = scraperOf(async () => {
      const http = client();
      await http.get(`${base}/board`);
      await http.get(`${base}/board`);
      return new JobResponseDto([]);
    });
    const { service } = createService([[Site.GREENHOUSE, board]]);

    await service.searchJobsWithDiagnostics(new ScraperInputDto({ siteType: [Site.GREENHOUSE], location: NEW_YORK }));

    expect(hits).toHaveLength(2);
  });
});

describe('JobsService — multi-location search under the crawl policy (Spec 1690 × Spec 1700)', () => {
  it('runs every location call in its own scrape context: site, plugin manifest, caller crawl, own signal', async () => {
    const seen: { location?: string; site?: string; plugin?: unknown; caller?: unknown; signal?: AbortSignal }[] = [];
    const scraper = scraperOf(async (input) => {
      const ctx = getScrapeContext();
      seen.push({ location: input.location, site: ctx?.site, plugin: ctx?.plugin, caller: ctx?.caller, signal: ctx?.signal });
      return new JobResponseDto([]);
    });
    const { service } = createService([[Site.THEMUSE, scraper]]);
    (service as any).registry.getMetadata = () => ({ crawl: { maxConcurrentPerHost: 1, minIntervalMs: 1000 } });

    await service.searchJobsWithDiagnostics(
      new ScraperInputDto({
        siteType: [Site.THEMUSE],
        locations: [NEW_YORK, CHICAGO],
        crawl: { maxConcurrentPerHost: 2 },
      } as Partial<ScraperInputDto>),
    );

    expect(seen.map((s) => s.location)).toEqual([NEW_YORK, CHICAGO]);
    for (const call of seen) {
      expect(call.site).toBe(Site.THEMUSE);
      expect(call.plugin).toEqual({ maxConcurrentPerHost: 1, minIntervalMs: 1000 });
      expect(call.caller).toEqual(expect.objectContaining({ maxConcurrentPerHost: 2 }));
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal?.aborted).toBe(false);
    }
    expect(seen[0].signal).not.toBe(seen[1].signal);
  });

  it('the search deadline aborts the in-flight location call and skips the rest', async () => {
    let signal: AbortSignal | undefined;
    const scraper = scraperOf(async (input) => {
      if (input.location !== NEW_YORK) return new JobResponseDto([]);
      signal = getScrapeContext()?.signal;
      await sleep(400);
      return new JobResponseDto([]);
    });
    const { service, warn } = createService([[Site.THEMUSE, scraper]], { deadlineMs: 80 });

    const out = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
    );

    expect(signal?.aborted).toBe(true);
    expect(scraper.scrape).toHaveBeenCalledTimes(1);
    expect(rowsFor(out.perSource, Site.THEMUSE).map((r) => r.location)).toEqual([NEW_YORK, CHICAGO]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('abandoned 1 in-flight source'))).toBe(true);
  });

  it('a rate_limited refusal (host cooling down) stops the remaining locations', async () => {
    const scraper = scraperOf(async () => {
      throw new HostCoolingDownError('host:api.example.com', 120_000, 429);
    });
    const { service, inc } = createService([[Site.THEMUSE, scraper]]);

    const out = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO, AUSTIN] }),
    );

    expect(scraper.scrape).toHaveBeenCalledTimes(1);
    const rows = rowsFor(out.perSource, Site.THEMUSE);
    expect(rows.map((r) => r.reason)).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
    expect(rows[1].detail).toContain('not attempted');
    expect(inc).toHaveBeenCalledWith({ site: Site.THEMUSE, status: 'location_skipped' });
  });

  it('a plugin that swallowed a rate_limited outcome also stops the remaining locations', async () => {
    const scraper = scraperOf(async () => new JobResponseDto([], new ScrapeDiagnostics('rate_limited', 'slot not granted')));
    const { service } = createService([[Site.THEMUSE, scraper]]);

    await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.THEMUSE], locations: [NEW_YORK, CHICAGO] }),
    );

    expect(scraper.scrape).toHaveBeenCalledTimes(1);
  });
});

describe('Spec 1700 config helpers', () => {
  it('locationPauseMs takes the larger of the interval and the declared gap', () => {
    expect(locationPauseMs(500, undefined)).toBe(500);
    expect(locationPauseMs(500, 3000)).toBe(3000);
    expect(locationPauseMs(0, 3000)).toBe(3000);
    expect(locationPauseMs(5000, 3000)).toBe(5000);
    expect(locationPauseMs(500, -1)).toBe(500);
    expect(locationPauseMs(500, Number.NaN)).toBe(500);
    expect(locationPauseMs(500, '3000')).toBe(500);
    expect(locationPauseMs(0, 10 * MAX_PLUGIN_REQUEST_INTERVAL_MS)).toBe(MAX_PLUGIN_REQUEST_INTERVAL_MS);
  });

  it('clampLocationInterval', () => {
    expect(clampLocationInterval(undefined)).toBe(DEFAULT_SEARCH_LOCATION_INTERVAL_MS);
    expect(clampLocationInterval('250')).toBe(250);
    expect(clampLocationInterval(0)).toBe(0);
    expect(clampLocationInterval(-1)).toBe(DEFAULT_SEARCH_LOCATION_INTERVAL_MS);
    expect(clampLocationInterval(MAX_SEARCH_LOCATION_INTERVAL_MS + 1)).toBe(DEFAULT_SEARCH_LOCATION_INTERVAL_MS);
    expect(clampLocationInterval(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SEARCH_LOCATION_INTERVAL_MS);
    expect(clampLocationInterval('abc')).toBe(DEFAULT_SEARCH_LOCATION_INTERVAL_MS);
  });

  it('readMaxSearchLocations prefers the config key, then the env var, then the default', () => {
    expect(readMaxSearchLocations({ get: (k) => (k === 'search.maxLocations' ? 4 : '7') })).toBe(4);
    expect(readMaxSearchLocations({ get: (k) => (k === SEARCH_MAX_LOCATIONS_ENV ? '7' : undefined) })).toBe(7);
    expect(readMaxSearchLocations({ get: () => undefined })).toBe(10);
    expect(readMaxSearchLocations({ get: () => '1e9' })).toBe(10);
  });
});
