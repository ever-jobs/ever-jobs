import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CompensationInterval,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { HylIoService } from '../src/hyl_io.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const LISTING = read('job-board');
const DETAIL: Record<string, string> = {
  'drone-technician': read('job-drone-technician'),
};

interface Seams {
  fetchListingHtml: () => Promise<string>;
  fetchDetailHtml: (client: unknown, url: string) => Promise<string>;
}

/**
 * Build a service whose listing returns the captured job-board page and whose
 * detail fetch returns the captured page for a slug we have a fixture for. The
 * fetch seam also fails the test if an Indeed URL is ever requested — Indeed is
 * link-only and must never be fetched.
 */
function makeService(listing = LISTING): HylIoService {
  const svc = new HylIoService();
  const seams = svc as unknown as Seams;
  seams.fetchListingHtml = async () => listing;
  seams.fetchDetailHtml = async (_client: unknown, url: string) => {
    if (/indeed\.com/i.test(url)) {
      throw new Error(`Indeed must never be fetched: ${url}`);
    }
    const slug = url.split('/').filter(Boolean).pop() ?? '';
    const html = DETAIL[slug];
    if (!html) throw new Error(`no fixture for ${slug}`);
    return html;
  };
  return svc;
}

describe('HylIoService', () => {
  it('enumerates every live role with an on-domain jobUrl and Indeed applyUrl', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs.length).toBe(1);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    const job = jobs[0];
    expect(job.site).toBe(Site.HYL_IO);
    expect(job.companyName).toBe('Hylio');
    expect(job.id).toBe('hyl_io-drone-technician');
    expect(job.title).toBe('DRONE TECHNICIAN');
    // canonical URL is the employer's own on-domain detail page ...
    expect(job.jobUrl).toBe('https://www.hyl.io/hiring/drone-technician');
    // ... while apply points out to Indeed (link only)
    expect(job.applyUrl).toContain('indeed.com/job/drone-technician');
    expect(job.jobUrl).not.toMatch(/indeed\.com/);
    expect(job.emails).toEqual([]);
  });

  it('leaves location null (site states none) and is not remote', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // The site states no per-role location; the HQ is never synthesized.
    expect(jobs[0].location).toBeNull();
    expect(jobs[0].isRemote).toBe(false);
  });

  it('maps the stated employment type and job type from the detail body', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const job = jobs[0];
    expect(job.employmentType).toBe('Full-time');
    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    // no posted date is stated on-site
    expect(job.datePosted).toBeNull();
  });

  it('parses the two-ended hourly pay via the shared helper', async () => {
    // "Pay: $16.00 - $20.00 per hour"
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const comp = jobs[0].compensation;
    expect(comp).toBeTruthy();
    expect(comp?.minAmount).toBe(16);
    expect(comp?.maxAmount).toBe(20);
    expect(comp?.interval).toBe(CompensationInterval.HOURLY);
    expect(comp?.currency).toBe('USD');
  });

  it('carries the detail body into the description as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const description = jobs[0].description ?? '';
    expect(description).toBeTruthy();
    expect(description).toMatch(/Job Summary/i);
    expect(description).toMatch(/Responsibilities/i);
    // Body comes entirely from hyl.io (the fetch seam throws if Indeed is ever
    // requested), so the description is the employer's own JD — which may itself
    // mention "Apply on Indeed", faithfully preserved.
  });

  it('degrades gracefully when a detail page cannot be fetched', async () => {
    const svc = new HylIoService();
    const seams = svc as unknown as Seams;
    seams.fetchListingHtml = async () => LISTING;
    seams.fetchDetailHtml = async () => {
      throw new Error('boom');
    };
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // role still emits from the listing alone, with a null description
    expect(jobs.length).toBe(1);
    expect(jobs[0].description).toBeNull();
    expect(jobs[0].title).toBe('DRONE TECHNICIAN');
    expect(jobs[0].jobUrl).toBe('https://www.hyl.io/hiring/drone-technician');
    expect(jobs[0].applyUrl).toContain('indeed.com/job/drone-technician');
  });

  it('applies searchTerm / resultsWanted filters', async () => {
    const svc = makeService();

    const match = await svc.scrape(new ScraperInputDto({ searchTerm: 'drone' }));
    expect(match.jobs.length).toBe(1);

    const miss = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'nonexistent-role-xyz' }),
    );
    expect(miss.jobs.length).toBe(0);

    const capped = await svc.scrape(new ScraperInputDto({ resultsWanted: 0 }));
    expect(capped.jobs.length).toBe(0);
  });

  it('returns nothing (no throw) when the board has no role cards', async () => {
    const svc = makeService('<html><body><h1>No openings</h1></body></html>');
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
