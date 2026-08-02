import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import {
  CompensationInterval,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { FrameworkCoModule } from '../src/framework_co.module';
import { FrameworkCoService } from '../src/framework_co.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const LISTING = read('framework_co-hiring');
const DETAIL: Record<string, string> = {
  'senior-software-engineer': read('framework_co-senior-software-engineer'),
  'senior-mechanical-engineer': read('framework_co-senior-mechanical-engineer'),
};

interface Seams {
  fetchListingHtml: () => Promise<string>;
  fetchDetailHtml: (client: unknown, url: string) => Promise<string>;
}

/**
 * Build a service whose listing returns the captured `/hiring` page and whose
 * detail fetch returns the captured `/jobs/{slug}` page. The seam fails the test
 * if any off-domain URL is ever requested — everything is on `framework.co`.
 */
function makeService(listing = LISTING): FrameworkCoService {
  const svc = new FrameworkCoService();
  const seams = svc as unknown as Seams;
  seams.fetchListingHtml = async () => listing;
  seams.fetchDetailHtml = async (_client: unknown, url: string) => {
    if (!/^https:\/\/framework\.co\//i.test(url)) {
      throw new Error(`only framework.co may be fetched: ${url}`);
    }
    const slug = url.split('/').filter(Boolean).pop() ?? '';
    const html = DETAIL[slug];
    if (!html) throw new Error(`no fixture for ${slug}`);
    return html;
  };
  return svc;
}

describe('FrameworkCoService (Spec 5063 — Framer two-step careers)', () => {
  it('resolves through FrameworkCoModule via NestJS DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FrameworkCoModule],
    }).compile();
    expect(moduleRef.get(FrameworkCoService)).toBeInstanceOf(FrameworkCoService);
  });

  it('exports the Site.FRAMEWORK_CO = "framework_co" enum value', () => {
    expect(Site.FRAMEWORK_CO).toBe('framework_co');
  });

  it('enumerates both live roles with on-domain jobUrl + shared /apply, empty fields empty', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs.length).toBe(2);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);

    const byId = new Map(jobs.map((j) => [j.id, j]));
    const swe = byId.get('framework_co-senior-software-engineer');
    expect(swe).toBeTruthy();
    expect(swe?.site).toBe(Site.FRAMEWORK_CO);
    expect(swe?.companyName).toBe('Framework Automation');
    expect(swe?.title).toBe('Senior Software Engineer');
    expect(swe?.jobUrl).toBe(
      'https://framework.co/jobs/senior-software-engineer',
    );
    // one shared on-domain application form; no per-role apply URL
    expect(swe?.applyUrl).toBe('https://framework.co/apply');

    for (const job of jobs) {
      expect(job.jobUrl).toMatch(/^https:\/\/framework\.co\/jobs\//);
      expect(job.applyUrl).toBe('https://framework.co/apply');
      expect(job.emails).toEqual([]);
      expect(job.datePosted).toBeNull();
      // employment type / job type are not stated on-site
      expect(job.employmentType == null).toBe(true);
      expect(job.jobType == null).toBe(true);
      expect(job.jobUrl).not.toMatch(/indeed\.com/i);
    }
  });

  it('maps the stated Los Angeles, CA location and is not remote', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    for (const job of jobs) {
      expect(job.location?.city).toBe('Los Angeles');
      expect(job.location?.state).toBe('CA');
      expect(job.isRemote).toBe(false);
    }
  });

  it('parses the stated $150k-$200k yearly range via the shared helper', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const comp = jobs[0].compensation;
    expect(comp).toBeTruthy();
    expect(comp?.minAmount).toBe(150000);
    expect(comp?.maxAmount).toBe(200000);
    expect(comp?.interval).toBe(CompensationInterval.YEARLY);
    expect(comp?.currency).toBe('USD');
  });

  it('carries the detail JD sections into the description as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const swe = jobs.find(
      (j) => j.id === 'framework_co-senior-software-engineer',
    );
    const description = swe?.description ?? '';
    expect(description).toBeTruthy();
    expect(description).toMatch(/About Framework/i);
    expect(description).toMatch(/The Opportunity/i);
    expect(description).toMatch(/Who You Are/i);
  });

  it('degrades to listing-only fields when a detail page cannot be fetched', async () => {
    const svc = new FrameworkCoService();
    const seams = svc as unknown as Seams;
    seams.fetchListingHtml = async () => LISTING;
    seams.fetchDetailHtml = async () => {
      throw new Error('boom');
    };
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs.length).toBe(2);
    for (const job of jobs) {
      // detail-only fields (description, salary, location) fall away ...
      expect(job.description).toBeNull();
      expect(job.compensation == null).toBe(true);
      expect(job.location == null).toBe(true);
      // ... but the role still emits with its on-domain jobUrl + slug title
      expect(job.jobUrl).toMatch(/^https:\/\/framework\.co\/jobs\//);
    }
    expect(new Set(jobs.map((j) => j.title))).toEqual(
      new Set(['Senior Software Engineer', 'Senior Mechanical Engineer']),
    );
  });

  it('applies searchTerm / offset / resultsWanted filters', async () => {
    const svc = makeService();

    // both role titles contain "engineer"
    const match = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'engineer' }),
    );
    expect(match.jobs.length).toBe(2);

    const miss = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'nonexistent-role-xyz' }),
    );
    expect(miss.jobs.length).toBe(0);

    const capped = await svc.scrape(new ScraperInputDto({ resultsWanted: 1 }));
    expect(capped.jobs.length).toBe(1);

    const offset = await svc.scrape(
      new ScraperInputDto({ offset: 2, resultsWanted: 10 }),
    );
    expect(offset.jobs.length).toBe(0);
  });

  it('returns nothing (no throw) when the board has no role links', async () => {
    const svc = makeService('<html><body><h1>No openings</h1></body></html>');
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
