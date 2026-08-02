import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { VightaeroModule } from '../src/vightaero.module';
import { VightaeroService } from '../src/vightaero.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const LISTING = read('vightaero-join-us');
const DETAIL: Record<string, string> = {
  gnc: read('vightaero-gnc'),
  propulsion: read('vightaero-propulsion'),
  'chief-engineer': read('vightaero-chief-engineer'),
};

interface Seams {
  fetchListingHtml: () => Promise<string>;
  fetchDetailHtml: (client: unknown, url: string) => Promise<string>;
}

/**
 * Build a service whose listing returns the captured `/join-us/` page and whose
 * detail fetch returns the captured `/join-us/{slug}/` page. The seam fails the
 * test if any off-domain URL is ever requested — everything is on vightaero.com.
 */
function makeService(listing = LISTING): VightaeroService {
  const svc = new VightaeroService();
  const seams = svc as unknown as Seams;
  seams.fetchListingHtml = async () => listing;
  seams.fetchDetailHtml = async (_client: unknown, url: string) => {
    if (!/^https:\/\/vightaero\.com\//i.test(url)) {
      throw new Error(`only vightaero.com may be fetched: ${url}`);
    }
    const slug = url.split('/').filter(Boolean).pop() ?? '';
    const html = DETAIL[slug];
    if (!html) throw new Error(`no fixture for ${slug}`);
    return html;
  };
  return svc;
}

describe('VightaeroService (Spec 5066 — hand-coded static two-step careers)', () => {
  it('resolves through VightaeroModule via NestJS DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [VightaeroModule],
    }).compile();
    expect(moduleRef.get(VightaeroService)).toBeInstanceOf(VightaeroService);
  });

  it('exports the Site.VIGHTAERO = "vightaero" enum value', () => {
    expect(Site.VIGHTAERO).toBe('vightaero');
  });

  it('enumerates the 3 real roles + the generalist card', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs.length).toBe(4);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    expect(new Set(jobs.map((j) => j.id))).toEqual(
      new Set([
        'vightaero-gnc',
        'vightaero-propulsion',
        'vightaero-chief-engineer',
        'vightaero-exceptional-generalist',
      ]),
    );

    for (const job of jobs) {
      expect(job.site).toBe(Site.VIGHTAERO);
      expect(job.companyName).toBe('Vight');
      expect(job.companyUrl).toBe('https://vightaero.com/join-us/');
      expect(job.isRemote).toBe(false);
      expect(job.datePosted).toBeNull();
      expect(job.compensation == null).toBe(true);
      // apply is by email; a mailto is not a web URL, so applyUrl stays unset
      expect(job.applyUrl == null).toBe(true);
      // every role's apply address decodes to join@vightaero.com
      expect(job.emails).toEqual(['join@vightaero.com']);
      expect(job.jobUrl).not.toMatch(/indeed\.com|linkedin\.com/i);
    }
  });

  it('uses the detail-page title/location/type + jobUrl for real roles', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());
    const byId = new Map(jobs.map((j) => [j.id, j]));

    const gnc = byId.get('vightaero-gnc');
    // the detail <h1> differs from the card title and wins
    expect(gnc?.title).toBe('Founding GNC and Flight Software Engineer');
    expect(gnc?.jobUrl).toBe('https://vightaero.com/join-us/gnc/');

    for (const id of ['vightaero-gnc', 'vightaero-propulsion', 'vightaero-chief-engineer']) {
      const job = byId.get(id);
      expect(job?.jobUrl).toMatch(/^https:\/\/vightaero\.com\/join-us\/[^/]+\/$/);
      // SF Bay Area -> city, CA -> state
      expect(job?.location?.city).toBe('SF Bay Area');
      expect(job?.location?.state).toBe('CA');
      expect(job?.employmentType).toBe('Full time');
      expect(job?.jobType).toEqual([JobType.FULL_TIME]);
    }
  });

  it('carries all detail JD sections (incl. About Vight boilerplate) as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());
    const gnc = jobs.find((j) => j.id === 'vightaero-gnc');
    const description = gnc?.description ?? '';

    expect(description).toMatch(/About Vight/i);
    expect(description).toMatch(/Role/i);
    expect(description).toMatch(/What You Will Do/i);
    expect(description).toMatch(/You Might Be A Fit If You/i);
    expect(description).toMatch(/Nice To Have/i);
    expect(description).toMatch(/What We Offer/i);
  });

  it('keeps the generalist from the card alone (no detail, no location/type)', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());
    const gen = jobs.find((j) => j.id === 'vightaero-exceptional-generalist');

    expect(gen?.title).toBe('Exceptional Generalist');
    // no detail page — jobUrl falls back to the listing
    expect(gen?.jobUrl).toBe('https://vightaero.com/join-us/');
    expect(gen?.location == null).toBe(true);
    expect(gen?.employmentType == null).toBe(true);
    expect(gen?.jobType == null).toBe(true);
    // the card copy is the description fallback
    expect(gen?.description).toMatch(/solved exceptionally hard/i);
    expect(gen?.emails).toEqual(['join@vightaero.com']);
  });

  it('degrades to listing-only fields when a detail page cannot be fetched', async () => {
    const svc = new VightaeroService();
    const seams = svc as unknown as Seams;
    seams.fetchListingHtml = async () => LISTING;
    seams.fetchDetailHtml = async () => {
      throw new Error('boom');
    };
    const { jobs } = await svc.scrape(new ScraperInputDto());
    const byId = new Map(jobs.map((j) => [j.id, j]));

    expect(jobs.length).toBe(4);
    // the real roles keep their card title/location/type + on-domain jobUrl ...
    const gnc = byId.get('vightaero-gnc');
    expect(gnc?.title).toBe('Founding GNC Engineer'); // card title (detail unavailable)
    expect(gnc?.location?.city).toBe('SF Bay Area');
    expect(gnc?.location?.state).toBe('CA');
    expect(gnc?.employmentType).toBe('Full time');
    expect(gnc?.jobUrl).toBe('https://vightaero.com/join-us/gnc/');
    // ... but the full JD (detail-only) falls away to the card copy
    expect(gnc?.description).toMatch(/controls, simulation/i);
  });

  it('applies searchTerm / offset / resultsWanted filters', async () => {
    const svc = makeService();

    const match = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'flight software' }),
    );
    expect(match.jobs.length).toBe(1);
    expect(match.jobs[0].id).toBe('vightaero-gnc');

    const miss = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'nonexistent-role-xyz' }),
    );
    expect(miss.jobs.length).toBe(0);

    const capped = await svc.scrape(new ScraperInputDto({ resultsWanted: 2 }));
    expect(capped.jobs.length).toBe(2);

    const offset = await svc.scrape(
      new ScraperInputDto({ offset: 4, resultsWanted: 10 }),
    );
    expect(offset.jobs.length).toBe(0);
  });

  it('returns nothing (no throw) when the listing has no role cards', async () => {
    const svc = makeService('<html><body><h1>No openings</h1></body></html>');
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
