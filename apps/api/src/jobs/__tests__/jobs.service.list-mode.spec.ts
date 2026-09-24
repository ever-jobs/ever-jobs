import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import type { IPluginMetadata, PluginCategory } from '@ever-jobs/plugin';
import { JobsService, LIST_MODE_SKIPPED_DETAIL } from '../jobs.service';
import type { SearchProgress } from '../search-input';

/**
 * Spec 1720 — list mode (no keyword) and `siteCategories` selection, plus the
 * Spec 1721 progress hook the NDJSON heartbeat reads.
 *
 * The harness mirrors `jobs.service.spec.ts` (service built with
 * `Object.create`, registry stubbed) but the stub registry carries real plugin
 * metadata so category and `requiresSearchTerm` routing can be exercised.
 */

interface FakePlugin {
  site: Site;
  category: PluginCategory;
  isAts?: boolean;
  requiresSearchTerm?: boolean;
  scraper: IScraper & { calls: ScraperInputDto[] };
}

/** A plugin that records every input it receives and returns `count` jobs. */
function recording(
  site: Site,
  category: PluginCategory,
  opts: { count?: number; isAts?: boolean; requiresSearchTerm?: boolean } = {},
): FakePlugin {
  const calls: ScraperInputDto[] = [];
  const scraper = {
    calls,
    scrape: jest.fn(async (input: ScraperInputDto) => {
      calls.push(input);
      const jobs = Array.from(
        { length: opts.count ?? 1 },
        (_, i) =>
          new JobPostDto({
            id: `${site}-${i}`,
            title: `Engineer ${i}`,
            companyName: `Co ${site}`,
            jobUrl: `https://example.com/${site}/${i}`,
          }),
      );
      return new JobResponseDto(jobs);
    }),
  };
  return { site, category, isAts: opts.isAts, requiresSearchTerm: opts.requiresSearchTerm, scraper };
}

/**
 * A plugin written the careless way: it builds its query by interpolating the
 * term, so an absent term would become the literal "undefined". It throws when
 * that happens — the fan-out must survive it.
 */
function throwsOnUndefinedTerm(site: Site, category: PluginCategory): FakePlugin {
  const calls: ScraperInputDto[] = [];
  const scraper = {
    calls,
    scrape: jest.fn(async (input: ScraperInputDto) => {
      calls.push(input);
      const url = `https://board.example/search?q=${input.searchTerm}`;
      if (/undefined|null/.test(url)) {
        throw new Error(`refusing to fetch ${url}`);
      }
      return new JobResponseDto([]);
    }),
  };
  return { site, category, scraper };
}

function createService(plugins: FakePlugin[]): JobsService {
  const service: any = Object.create(JobsService.prototype);
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const bySite = new Map(plugins.map((p) => [p.site, p]));
  service.registry = {
    size: bySite.size,
    siteForDomain: () => undefined,
    getScraper: (site: Site) => bySite.get(site)?.scraper,
    listSiteKeys: () => [...bySite.keys()],
    listAtsSites: () => plugins.filter((p) => p.isAts).map((p) => p.site),
    listSources: (): IPluginMetadata[] =>
      plugins.map((p) => ({
        site: p.site,
        name: String(p.site),
        category: p.category,
        isAts: p.isAts,
        requiresSearchTerm: p.requiresSearchTerm,
      })),
  };
  service.configService = {
    get: (key: string, def?: unknown) => {
      if (key === 'retry') {
        return { defaultRetries: 0, defaultDelayMs: 0, defaultBackoff: 'linear', perSource: {} };
      }
      if (key === 'search.concurrency') return 4;
      if (key === 'search.deadlineMs') return 0;
      return def;
    },
  };
  service.metrics = {
    scraperDuration: { startTimer: () => () => undefined },
    scraperRequestsTotal: { inc: jest.fn() },
  };
  return service as JobsService;
}

/** Every keyword-ish value any scraper received, as the exact runtime value. */
function receivedTerms(plugins: FakePlugin[]): unknown[] {
  return plugins.flatMap((p) => p.scraper.calls.map((c) => c.searchTerm));
}

describe('JobsService — list mode (Spec 1720)', () => {
  it.each([
    ['omitted', {}],
    ['null', { searchTerm: null }],
    ['empty string', { searchTerm: '' }],
    ['whitespace only', { searchTerm: '   ' }],
  ])('searchTerm %s reaches every plugin as absent (never "undefined"/"null"/"   ")', async (_l, extra) => {
    const plugins = [
      recording(Site.LINKEDIN, 'job-board'),
      recording(Site.REMOTEOK, 'remote'),
    ];
    const service = createService(plugins);

    const { jobs } = await service.searchJobsWithDiagnostics(
      new ScraperInputDto(extra as Partial<ScraperInputDto>),
    );

    expect(jobs).toHaveLength(2);
    const terms = receivedTerms(plugins);
    expect(terms).toEqual([undefined, undefined]);
    for (const call of plugins.flatMap((p) => p.scraper.calls)) {
      expect('searchTerm' in call ? call.searchTerm : undefined).toBeUndefined();
      expect(JSON.stringify(call)).not.toMatch(/"searchTerm"/);
    }
  });

  it('trims a real keyword before dispatch', async () => {
    const plugin = recording(Site.LINKEDIN, 'job-board');
    const service = createService([plugin]);
    await service.searchJobsWithDiagnostics(new ScraperInputDto({ searchTerm: '  data engineer ' }));
    expect(plugin.scraper.calls[0]!.searchTerm).toBe('data engineer');
  });

  it('does not dispatch a requiresSearchTerm plugin in list mode and reports it as empty', async () => {
    const needsKeyword = recording(Site.BAYT, 'regional', { requiresSearchTerm: true });
    const lists = recording(Site.LINKEDIN, 'job-board', { count: 3 });
    const service = createService([needsKeyword, lists]);

    const { jobs, perSource } = await service.searchJobsWithDiagnostics(new ScraperInputDto({}));

    expect(needsKeyword.scraper.scrape).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(3);
    const row = perSource.find((r) => r.site === Site.BAYT);
    expect(row).toMatchObject({ count: 0, reason: 'empty', detail: LIST_MODE_SKIPPED_DETAIL });
  });

  it('still dispatches a requiresSearchTerm plugin when a keyword is given', async () => {
    const needsKeyword = recording(Site.BAYT, 'regional', { requiresSearchTerm: true });
    const service = createService([needsKeyword]);

    const { jobs, perSource } = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ searchTerm: 'nurse' }),
    );

    expect(needsKeyword.scraper.scrape).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(1);
    expect(perSource.find((r) => r.detail === LIST_MODE_SKIPPED_DETAIL)).toBeUndefined();
  });

  it('skips a requiresSearchTerm plugin even when selected explicitly via siteType', async () => {
    const needsKeyword = recording(Site.NAUKRI, 'regional', { requiresSearchTerm: true });
    const service = createService([needsKeyword]);

    const { jobs, perSource } = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.NAUKRI] }),
    );

    expect(needsKeyword.scraper.scrape).not.toHaveBeenCalled();
    expect(jobs).toEqual([]);
    expect(perSource).toEqual([
      expect.objectContaining({ site: Site.NAUKRI, reason: 'empty', detail: LIST_MODE_SKIPPED_DETAIL }),
    ]);
  });

  it('a plugin that throws on an absent term does not take the fan-out down', async () => {
    const careless = throwsOnUndefinedTerm(Site.GOOGLE, 'job-board');
    const fine = recording(Site.LINKEDIN, 'job-board', { count: 2 });
    const alsoFine = recording(Site.REMOTIVE, 'remote', { count: 1 });
    const service = createService([careless, fine, alsoFine]);

    const { jobs, perSource } = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ searchTerm: '' }),
    );

    // The careless plugin was called with an ABSENT term — so what it
    // interpolated was the JS value `undefined`, which the orchestrator
    // cannot prevent. What the orchestrator guarantees is that it never
    // hands a plugin the *string* "undefined"/"null", and that one bad
    // plugin costs one row, not the request.
    expect(careless.scraper.calls[0]!.searchTerm).toBeUndefined();
    expect(jobs).toHaveLength(3);
    const row = perSource.find((r) => r.site === Site.GOOGLE)!;
    expect(row.count).toBe(0);
    expect(row.reason).not.toBe('ok');
    expect(perSource.find((r) => r.site === Site.LINKEDIN)).toMatchObject({ count: 2, reason: 'ok' });
  });

  it('logs term=<none> and [list mode] in the fan-out line', async () => {
    const service = createService([recording(Site.LINKEDIN, 'job-board')]);
    await service.searchJobsWithDiagnostics(new ScraperInputDto({ searchTerm: ' ' }));
    const lines = ((service as any).logger.log as jest.Mock).mock.calls.map((c) => String(c[0]));
    const fanOut = lines.find((l) => l.startsWith('Running '))!;
    expect(fanOut).toContain('term=<none> [list mode]');
    expect(lines.join('\n')).not.toMatch(/term="?undefined|term="?null/);
  });

  it('logs the quoted term outside list mode', async () => {
    const service = createService([recording(Site.LINKEDIN, 'job-board')]);
    await service.searchJobsWithDiagnostics(new ScraperInputDto({ searchTerm: 'go' }));
    const lines = ((service as any).logger.log as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(lines.find((l) => l.startsWith('Running '))).toContain('term="go")');
  });
});

describe('JobsService — siteCategories (Spec 1720)', () => {
  function catalogue() {
    return {
      board: recording(Site.LINKEDIN, 'job-board'),
      remote: recording(Site.REMOTEOK, 'remote'),
      company: recording(Site.AMAZON, 'company'),
      niche: recording(Site.DICE, 'niche'),
      ats: recording(Site.GREENHOUSE, 'ats', { isAts: true }),
    };
  }
  function called(p: Record<string, FakePlugin>): string[] {
    return Object.entries(p)
      .filter(([, plugin]) => (plugin.scraper.scrape as jest.Mock).mock.calls.length > 0)
      .map(([name]) => name)
      .sort();
  }

  it('without siteCategories the default selection is unchanged (every non-ATS plugin)', async () => {
    const p = catalogue();
    await createService(Object.values(p)).searchJobsWithDiagnostics(new ScraperInputDto({}));
    expect(called(p)).toEqual(['board', 'company', 'niche', 'remote']);
  });

  it('narrows the default fan-out to the requested categories', async () => {
    const p = catalogue();
    await createService(Object.values(p)).searchJobsWithDiagnostics(
      new ScraperInputDto({ siteCategories: ['job-board', 'remote'] }),
    );
    expect(called(p)).toEqual(['board', 'remote']);
  });

  it('an empty siteCategories array does not narrow', async () => {
    const p = catalogue();
    await createService(Object.values(p)).searchJobsWithDiagnostics(
      new ScraperInputDto({ siteCategories: [] }),
    );
    expect(called(p)).toEqual(['board', 'company', 'niche', 'remote']);
  });

  it('["ats"] without companySlug selects nothing (ATS still needs a slug)', async () => {
    const p = catalogue();
    const { jobs } = await createService(Object.values(p)).searchJobsWithDiagnostics(
      new ScraperInputDto({ siteCategories: ['ats'] }),
    );
    expect(called(p)).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it('["ats"] with companySlug selects the ATS plugins', async () => {
    const p = catalogue();
    await createService(Object.values(p)).searchJobsWithDiagnostics(
      new ScraperInputDto({ siteCategories: ['ats'], companySlug: 'acme' }),
    );
    expect(called(p)).toEqual(['ats']);
  });

  it('companySlug + a non-ATS category narrows the ATS-only default to nothing', async () => {
    const p = catalogue();
    await createService(Object.values(p)).searchJobsWithDiagnostics(
      new ScraperInputDto({ siteCategories: ['company'], companySlug: 'acme' }),
    );
    expect(called(p)).toEqual([]);
  });

  it('an explicit siteType wins over siteCategories', async () => {
    const p = catalogue();
    const service = createService(Object.values(p));
    await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.AMAZON], siteCategories: ['remote'] }),
    );
    expect(called(p)).toEqual(['company']);
    const debug = ((service as any).logger.debug as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(debug.some((l) => l.includes('siteCategories') && l.includes('ignored'))).toBe(true);
  });

  it('an unknown category is a 400 (BadRequestException) for direct callers', async () => {
    const p = catalogue();
    await expect(
      createService(Object.values(p)).searchJobsWithDiagnostics(
        new ScraperInputDto({ siteCategories: ['boards' as never] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(called(p)).toEqual([]);
  });

  it('list mode and categories compose: keyword-only plugins in the category are skipped', async () => {
    const regionalNeedsKeyword = recording(Site.BAYT, 'regional', { requiresSearchTerm: true });
    const regionalLists = recording(Site.NAUKRI, 'regional');
    const board = recording(Site.LINKEDIN, 'job-board');
    const service = createService([regionalNeedsKeyword, regionalLists, board]);

    const { perSource } = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteCategories: ['regional'] }),
    );

    expect(regionalNeedsKeyword.scraper.scrape).not.toHaveBeenCalled();
    expect(regionalLists.scraper.scrape).toHaveBeenCalledTimes(1);
    expect(board.scraper.scrape).not.toHaveBeenCalled();
    expect(perSource.map((r) => r.site).sort()).toEqual([Site.BAYT, Site.NAUKRI].sort());
  });
});

describe('JobsService — progress hook (Spec 1721)', () => {
  it('reports start (0 of N) and then every settled source with a running job count', async () => {
    const plugins = [
      recording(Site.LINKEDIN, 'job-board', { count: 2 }),
      recording(Site.REMOTEOK, 'remote', { count: 3 }),
      throwsOnUndefinedTerm(Site.GOOGLE, 'job-board'),
    ];
    const events: SearchProgress[] = [];
    await createService(plugins).searchJobsWithDiagnostics(new ScraperInputDto({}), {
      onProgress: (p) => events.push({ ...p }),
    });

    expect(events[0]).toEqual({ sourcesDone: 0, sourcesTotal: 3, jobs: 0 });
    expect(events).toHaveLength(4);
    expect(events[3]).toEqual({ sourcesDone: 3, sourcesTotal: 3, jobs: 5 });
    // Monotonic.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sourcesDone).toBe(events[i - 1]!.sourcesDone + 1);
      expect(events[i]!.jobs).toBeGreaterThanOrEqual(events[i - 1]!.jobs);
    }
  });

  it('a throwing progress listener never breaks the fan-out', async () => {
    const service = createService([recording(Site.LINKEDIN, 'job-board', { count: 2 })]);
    const { jobs } = await service.searchJobsWithDiagnostics(new ScraperInputDto({}), {
      onProgress: () => {
        throw new Error('listener bug');
      },
    });
    expect(jobs).toHaveLength(2);
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('progress listener threw'),
    );
  });

  it('keyword-skipped plugins are not counted as dispatched sources', async () => {
    const events: SearchProgress[] = [];
    await createService([
      recording(Site.BAYT, 'regional', { requiresSearchTerm: true }),
      recording(Site.LINKEDIN, 'job-board'),
    ]).searchJobsWithDiagnostics(new ScraperInputDto({}), { onProgress: (p) => events.push({ ...p }) });
    expect(events[0]!.sourcesTotal).toBe(1);
  });
});
