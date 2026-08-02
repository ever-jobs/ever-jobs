import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { IperionxService } from '../src/iperionx.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const LISTING = read('careers');

interface Seams {
  fetchListingHtml: () => Promise<string>;
}

/** Build a service whose listing returns the captured careers page. */
function makeService(listing = LISTING): IperionxService {
  const svc = new IperionxService();
  (svc as unknown as Seams).fetchListingHtml = async () => listing;
  return svc;
}

describe('IperionxService', () => {
  it('enumerates every summary-board role, deduped, with off-site Indeed apply URLs', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // Six live openings, each with a unique id.
    expect(jobs.length).toBe(6);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);

    for (const job of jobs) {
      expect(job.site).toBe(Site.IPERIONX);
      expect(job.companyName).toBe('IperionX');
      expect((job.id ?? '').startsWith('iperionx-')).toBe(true);
      // apply/job URL points to the Indeed job page (never fetched by us)
      expect(job.jobUrl).toContain('indeed.com/job/');
      expect(job.applyUrl).toBe(job.jobUrl);
      expect(job.emails).toEqual([]);
    }
  });

  it('captures title (location suffix stripped) and the summary blurb as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const eng = jobs.find((j) =>
      (j.id ?? '').startsWith('iperionx-manufacturing-engineer-'),
    );
    expect(eng).toBeTruthy();
    expect(eng?.title).toBe('Manufacturing Engineer');
    expect(eng?.description).toBeTruthy();
    expect(eng?.description).toMatch(/IperionX is seeking/i);

    // A title with an internal hyphen keeps it; only the trailing location goes.
    const sup = jobs.find((j) =>
      (j.id ?? '').startsWith('iperionx-production-supervisor-night-'),
    );
    expect(sup?.title).toBe('Production Supervisor - Night');
  });

  it('classifies the bare-state suffix (Virginia) as a state via the shared opt-in', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    for (const job of jobs) {
      expect(job.location?.state).toBe('VA');
      expect(job.location?.city).toBeFalsy();
      expect(job.location?.displayLocation()).toBe('VA');
      expect(job.isRemote).toBe(false);
    }
  });

  it('leaves unstated fields empty (no date, pay, or employment type on-site)', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    for (const job of jobs) {
      expect(job.datePosted).toBeNull();
      expect(job.compensation).toBeUndefined();
      expect(job.employmentType).toBeUndefined();
      expect(job.jobType).toBeUndefined();
    }
  });

  it('applies searchTerm / resultsWanted filters', async () => {
    const svc = makeService();

    const match = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'coordinator' }),
    );
    expect(match.jobs.length).toBe(1);
    expect(match.jobs[0].title).toMatch(/Quality Coordinator/i);

    const miss = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'nonexistent-role-xyz' }),
    );
    expect(miss.jobs.length).toBe(0);

    const capped = await svc.scrape(new ScraperInputDto({ resultsWanted: 2 }));
    expect(capped.jobs.length).toBe(2);
  });

  it('returns nothing (no throw) when the page has no role cards', async () => {
    const svc = makeService('<html><body><h1>No openings</h1></body></html>');
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
