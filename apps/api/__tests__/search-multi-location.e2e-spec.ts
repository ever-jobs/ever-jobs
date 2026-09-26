import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { TheMuseService } from '@ever-jobs/source-themuse';
import { applyJobExclusions } from '@ever-jobs/common';
import { JobsService, LocatedSourceDiagnosticDto } from '../src/jobs/jobs.service';

/**
 * Spec 1700 — live check of the multi-location fan-out against a public job
 * API that filters by location server-side.
 *
 * Exactly two upstream GETs (one per location), made one after another with
 * the default politeness pause between them. The exclusion invariants are
 * checked on the same live result, so no further request is made. An upstream
 * outage is logged and tolerated rather than failing CI.
 */

const LOCATIONS = ['New York, NY', 'Chicago, IL'];

function createService(): JobsService {
  const scraper = new TheMuseService();
  const service: any = Object.create(JobsService.prototype);
  service.logger = new Logger('MultiLocationE2E');
  service.registry = {
    size: 1,
    siteForDomain: () => undefined,
    getScraper: (site: Site) => (site === Site.THEMUSE ? scraper : undefined),
    listSiteKeys: () => [Site.THEMUSE],
    listAtsSites: () => [],
    listSources: () => [],
    getMetadata: () => undefined,
  };
  service.configService = {
    get: (key: string, def?: unknown) => {
      if (key === 'retry') {
        return { defaultRetries: 1, defaultDelayMs: 1000, defaultBackoff: 'linear', perSource: {} };
      }
      if (key === 'search.deadlineMs') return 60_000;
      return def;
    },
  };
  service.metrics = {
    scraperDuration: { startTimer: () => () => undefined },
    scraperRequestsTotal: { inc: () => undefined },
  };
  return service as JobsService;
}

describe('multi-location search (live, Spec 1700)', () => {
  jest.setTimeout(90_000);

  it('returns one row per location and no same-source duplicates', async () => {
    const service = createService();
    const out = await service.searchJobsWithDiagnostics(
      new ScraperInputDto({ siteType: [Site.THEMUSE], searchTerm: '', locations: LOCATIONS, resultsWanted: 3 }),
    );

    const rows = out.perSource.filter((r) => r.site === Site.THEMUSE) as LocatedSourceDiagnosticDto[];
    expect(rows.map((r) => r.location)).toEqual(LOCATIONS);

    if (rows.every((r) => r.reason === 'fetch_error' || r.reason === 'timeout')) {
      new Logger('MultiLocationE2E').warn(`upstream unavailable, skipping assertions: ${JSON.stringify(rows)}`);
      return;
    }

    for (const row of rows) expect(['ok', 'empty', 'partial']).toContain(row.reason);
    const ids = out.jobs.map((j) => `${j.site}|${j.id}|${j.jobUrl}`);
    expect(new Set(ids).size).toBe(ids.length);
    const rawObserved = rows.reduce((sum, r) => sum + r.count, 0);
    expect(out.jobs.length).toBeLessThanOrEqual(rawObserved);

    // Exclusion invariants on live titles — independent of the board's contents.
    const first = out.jobs[0]?.title?.split(/\s+/)[0];
    if (!first) return;
    const filtered = applyJobExclusions(out.jobs, { titleTerms: [first] });
    expect(filtered.kept.length + filtered.excluded.length).toBe(out.jobs.length);
    expect(filtered.excluded.length).toBeGreaterThan(0);
    expect(applyJobExclusions(out.jobs, {}).kept).toEqual(out.jobs);
  });
});
