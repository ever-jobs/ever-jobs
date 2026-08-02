import { readFileSync } from 'fs';
import { join } from 'path';
import { CompensationInterval, ScraperInputDto, Site } from '@ever-jobs/models';
import { AvalanchefusionService } from '../src/avalanchefusion.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const LISTING = read('open-positions');
const DETAIL: Record<string, string> = {
  'mechanical-engineer': read('mechanical-engineer'),
  'human-resources-generalist': read('human-resources-generalist'),
  'experimental-plasma-scientist': read('experimental-plasma-scientist'),
};

interface Seams {
  fetchListingHtml: () => Promise<string>;
  fetchDetailHtml: (
    client: unknown,
    url: string,
  ) => Promise<string>;
}

/**
 * Build a service whose listing returns the captured board and whose detail
 * fetch returns the captured page for a slug we have a fixture for; slugs
 * without a fixture reject (exercising graceful per-role degradation).
 */
function makeService(): AvalanchefusionService {
  const svc = new AvalanchefusionService();
  const seams = svc as unknown as Seams;
  seams.fetchListingHtml = async () => LISTING;
  seams.fetchDetailHtml = async (_client: unknown, url: string) => {
    const slug = url.split('/').filter(Boolean).pop() ?? '';
    const html = DETAIL[slug];
    if (!html) throw new Error(`no fixture for ${slug}`);
    return html;
  };
  return svc;
}

describe('AvalanchefusionService', () => {
  it('parses every open role from the board with a LinkedIn apply URL', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // 9 roles on the board at capture time
    expect(jobs.length).toBe(9);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    for (const job of jobs) {
      expect(job.site).toBe(Site.AVALANCHEFUSION);
      expect(job.companyName).toBe('Avalanche Energy');
      expect(job.id ?? '').toMatch(/^avalanchefusion-/);
      expect(job.jobUrl).toContain('/careers/open-position/');
      // apply, when present, points at a LinkedIn job posting (never an email)
      if (job.applyUrl) {
        expect(job.applyUrl).toMatch(/linkedin\.com\/jobs\/view\/\d+/);
      }
      expect(job.emails).toEqual([]);
      expect(job.datePosted).toBeNull();
    }

    // every role we have a detail fixture for resolves a LinkedIn apply URL
    for (const title of [
      'Mechanical Engineer',
      'Human Resources Generalist',
      'Experimental Plasma Scientist',
    ]) {
      const job = jobs.find((j) => j.title === title);
      expect(job?.applyUrl).toMatch(/linkedin\.com\/jobs\/view\/\d+/);
    }
  });

  it('reads the structured Salary Range as a yearly range from the detail page', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const eng = jobs.find((j) => j.title === 'Mechanical Engineer');
    expect(eng?.compensation).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 135000,
      maxAmount: 175000,
      currency: 'USD',
    });

    const hr = jobs.find((j) => j.title === 'Human Resources Generalist');
    expect(hr?.compensation).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 80000,
      maxAmount: 115000,
    });
  });

  it('carries the rich-text body into the description as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const eng = jobs.find((j) => j.title === 'Mechanical Engineer');
    expect(eng?.description).toBeTruthy();
    expect(eng?.description).toMatch(/Avalanche Energy/i);
    // markdown bolding survives the turndown conversion
    expect(eng?.description).toMatch(/\*\*/);
  });

  it('defaults the location to the company metro (no structured per-role location)', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const plasma = jobs.find((j) => j.title === 'Experimental Plasma Scientist');
    expect(plasma?.location?.displayLocation()).toBe('Seattle, WA');
    expect(plasma?.isRemote).toBe(false);
  });

  it('degrades gracefully when a detail page cannot be fetched (keeps listing fields)', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // a role without a detail fixture still appears, from listing data alone
    const noDetail = jobs.find((j) => j.title === 'High Voltage Engineer');
    expect(noDetail).toBeDefined();
    expect(noDetail?.jobUrl).toContain('high-voltage-engineer');
    expect(noDetail?.compensation).toBeUndefined();
    expect(noDetail?.applyUrl).toBeNull();
    // company location default still applies
    expect(noDetail?.location?.displayLocation()).toBe('Seattle, WA');
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'engineer', resultsWanted: 2 }),
    );

    expect(jobs.length).toBe(2);
    for (const job of jobs) {
      const haystack = `${job.title} ${job.description ?? ''}`.toLowerCase();
      expect(haystack).toContain('engineer');
    }
  });

  it('returns empty (no throw) when the board has no roles', async () => {
    const svc = makeService();
    (svc as unknown as Seams).fetchListingHtml = async () =>
      '<html><body><h1>Careers</h1></body></html>';
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
