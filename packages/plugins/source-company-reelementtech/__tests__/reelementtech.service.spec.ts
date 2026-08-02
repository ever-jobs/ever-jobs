import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { ReelementtechService } from '../src/reelementtech.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const LISTING = read('careers');
const DETAIL: Record<string, string> = {
  'job-application---human-resources-hr-manager': read(
    'job-application---human-resources-hr-manager',
  ),
  'job-application---environmental-health-safety-ehs-manager': read(
    'job-application---environmental-health-safety-ehs-manager',
  ),
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
function makeService(listing = LISTING): ReelementtechService {
  const svc = new ReelementtechService();
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

describe('ReelementtechService', () => {
  it('enumerates every live role with an on-page apply URL', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs.length).toBe(2);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    for (const job of jobs) {
      expect(job.site).toBe(Site.REELEMENTTECH);
      expect(job.companyName).toBe('ReElement Technologies');
      expect(job.id ?? '').toMatch(/^reelementtech-/);
      expect(job.jobUrl).toContain('/jobs/');
      // apply is the on-page form on the detail page — same as jobUrl
      expect(job.applyUrl).toBe(job.jobUrl);
      expect(job.emails).toEqual([]);
      expect(job.datePosted).toBeNull();
      expect(job.compensation).toBeUndefined();
    }

    const titles = jobs.map((j) => j.title).sort();
    expect(titles).toEqual([
      'Environmental, Health & Safety (EHS) Manager',
      'Human Resources (HR) Manager',
    ]);
  });

  it('uses the per-role stated location (Marion, IN), not the HQ footer', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    for (const job of jobs) {
      expect(job.location?.displayLocation()).toBe('Marion, IN');
      expect(job.isRemote).toBe(false);
    }
    // never the corporate-HQ footer address
    expect(
      jobs.some((j) => (j.location?.displayLocation() ?? '').includes('Fishers')),
    ).toBe(false);
  });

  it('carries the rich-text body into the description as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const hr = jobs.find((j) => j.title === 'Human Resources (HR) Manager');
    expect(hr?.description).toBeTruthy();
    expect(hr?.description).toMatch(/Job Summary/i);
    // the trailing on-page apply form is not part of the richtext body
    expect(hr?.description ?? '').not.toMatch(/Apply for this job/i);
  });

  it('degrades gracefully when a detail page cannot be fetched', async () => {
    const svc = new ReelementtechService();
    const seams = svc as unknown as Seams;
    seams.fetchListingHtml = async () => LISTING;
    seams.fetchDetailHtml = async () => {
      throw new Error('boom');
    };
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // roles still emit from the listing alone, with a null description
    expect(jobs.length).toBe(2);
    for (const job of jobs) {
      expect(job.description).toBeNull();
      expect(job.location?.displayLocation()).toBe('Marion, IN');
      expect(job.title).toBeTruthy();
    }
  });

  it('applies searchTerm / resultsWanted filters', async () => {
    const svc = makeService();

    const hrOnly = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'human resources' }),
    );
    expect(hrOnly.jobs.length).toBe(1);
    expect(hrOnly.jobs[0].title).toBe('Human Resources (HR) Manager');

    const capped = await svc.scrape(new ScraperInputDto({ resultsWanted: 1 }));
    expect(capped.jobs.length).toBe(1);
  });

  it('returns nothing (no throw) when the careers page has no role cards', async () => {
    const svc = makeService('<html><body><h1>No openings</h1></body></html>');
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
