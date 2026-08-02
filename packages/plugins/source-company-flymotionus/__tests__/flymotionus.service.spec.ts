import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CompensationInterval,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { FlymotionusService } from '../src/flymotionus.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const LISTING = read('careers');
const DETAIL: Record<string, string> = {
  'event-coordinator': read('job-event-coordinator'),
};

interface Seams {
  fetchListingHtml: () => Promise<string>;
  fetchDetailHtml: (client: unknown, url: string) => Promise<string>;
}

/**
 * Build a service whose listing returns the captured careers page and whose
 * detail fetch returns the captured page for a slug we have a fixture for;
 * slugs without a fixture reject (exercising graceful per-role degradation).
 */
function makeService(listing = LISTING): FlymotionusService {
  const svc = new FlymotionusService();
  const seams = svc as unknown as Seams;
  seams.fetchListingHtml = async () => listing;
  seams.fetchDetailHtml = async (_client: unknown, url: string) => {
    const slug = url.split('/').filter(Boolean).pop() ?? '';
    const html = DETAIL[slug];
    if (!html) throw new Error(`no fixture for ${slug}`);
    return html;
  };
  return svc;
}

describe('FlymotionusService', () => {
  it('enumerates every live role with an on-page apply URL', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs.length).toBe(1);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    const job = jobs[0];
    expect(job.site).toBe(Site.FLYMOTIONUS);
    expect(job.companyName).toBe('FLYMOTION');
    expect(job.id).toBe('flymotionus-event-coordinator');
    expect(job.title).toBe('Event Coordinator');
    expect(job.jobUrl).toContain('/jobs/event-coordinator');
    // apply is the on-page HubSpot form on the detail page — same as jobUrl
    expect(job.applyUrl).toBe(job.jobUrl);
    expect(job.emails).toEqual([]);
  });

  it('uses the per-role stated location (Tampa, FL), not the HQ footer', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs[0].location?.displayLocation()).toBe('Tampa, FL');
    expect(jobs[0].isRemote).toBe(false);
  });

  it('maps the structured detail cards (employment type, job type, posted date)', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const job = jobs[0];
    expect(job.employmentType).toBe('Full-time');
    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    expect(job.datePosted).toBeInstanceOf(Date);
    expect((job.datePosted as Date).getUTCFullYear()).toBe(2024);
  });

  it('parses the stated single-bound pay via the shared helper (min-only)', async () => {
    // "Pay: From $48,000.00 per year" is a lower bound only. The shared
    // salaryToCompensation (Spec 5058) yields minAmount with no fabricated
    // ceiling — the plugin no longer hand-rolls a local fallback.
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const comp = jobs[0].compensation;
    expect(comp).toBeTruthy();
    expect(comp?.minAmount).toBe(48000);
    expect(comp?.maxAmount).toBeUndefined();
    expect(comp?.interval).toBe(CompensationInterval.YEARLY);
    expect(comp?.currency).toBe('USD');
  });

  it('carries the rich-text body into the description as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs[0].description).toBeTruthy();
    expect(jobs[0].description).toMatch(/Event Coordinator/i);
  });

  it('degrades gracefully when a detail page cannot be fetched', async () => {
    const svc = new FlymotionusService();
    const seams = svc as unknown as Seams;
    seams.fetchListingHtml = async () => LISTING;
    seams.fetchDetailHtml = async () => {
      throw new Error('boom');
    };
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // role still emits from the listing alone, with a null description
    expect(jobs.length).toBe(1);
    expect(jobs[0].description).toBeNull();
    expect(jobs[0].location?.displayLocation()).toBe('Tampa, FL');
    expect(jobs[0].employmentType).toBe('Full-time');
    expect(jobs[0].title).toBe('Event Coordinator');
  });

  it('applies searchTerm / resultsWanted filters', async () => {
    const svc = makeService();

    const match = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'event' }),
    );
    expect(match.jobs.length).toBe(1);

    const miss = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'nonexistent-role-xyz' }),
    );
    expect(miss.jobs.length).toBe(0);

    const capped = await svc.scrape(new ScraperInputDto({ resultsWanted: 0 }));
    expect(capped.jobs.length).toBe(0);
  });

  it('returns nothing (no throw) when the careers page has no role cards', async () => {
    const svc = makeService('<html><body><h1>No openings</h1></body></html>');
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
