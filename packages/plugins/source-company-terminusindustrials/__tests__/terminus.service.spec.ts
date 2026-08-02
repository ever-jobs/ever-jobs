import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { TerminusIndustrialsModule } from '../src/terminus.module';
import { TerminusIndustrialsService } from '../src/terminus.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

const CAREERS = read('terminus-careers');
const EMPTY = read('terminus-careers-empty');

interface Seams {
  fetchCareersHtml: () => Promise<string>;
}

/**
 * Build a service whose careers fetch returns the captured `/careers` page.
 * The seam records any URL it would fetch so the test can assert the scraper
 * only ever hits the employer's own domain (no Indeed / third party).
 */
function makeService(html = CAREERS): TerminusIndustrialsService {
  const svc = new TerminusIndustrialsService();
  (svc as unknown as Seams).fetchCareersHtml = async () => html;
  return svc;
}

describe('TerminusIndustrialsService (Spec 5064 — Next.js single-page careers)', () => {
  it('resolves through the module via NestJS DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusIndustrialsModule],
    }).compile();
    expect(moduleRef.get(TerminusIndustrialsService)).toBeInstanceOf(
      TerminusIndustrialsService,
    );
  });

  it('exports the Site.TERMINUSINDUSTRIALS = "terminusindustrials" enum value', () => {
    expect(Site.TERMINUSINDUSTRIALS).toBe('terminusindustrials');
  });

  it('maps the on-domain role: title-derived id, /careers jobUrl, no apply URL', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    expect(jobs.length).toBe(1);
    const job = jobs[0];
    expect(job.id).toBe(
      'terminusindustrials-head-of-product-engineering-large-power-transformers',
    );
    expect(job.site).toBe(Site.TERMINUSINDUSTRIALS);
    expect(job.companyName).toBe('Terminus Industrials');
    expect(job.title).toBe(
      'Head of Product Engineering (Large Power Transformers)',
    );
    // no per-role detail route — the careers page is the canonical URL
    expect(job.jobUrl).toBe('https://www.terminusindustrials.com/careers');
    // apply is an on-page modal form; no standalone apply URL
    expect(job.applyUrl).toBeNull();
    expect(job.emails).toEqual([]);
    expect(job.datePosted).toBeNull();
    // no salary is stated on-site — never fabricated
    expect(job.compensation == null).toBe(true);
    // never links to Indeed / any third party
    expect(job.jobUrl).not.toMatch(/indeed\.com/i);
    expect(job.applyUrl ?? '').not.toMatch(/indeed\.com/i);
  });

  it('maps the stated Austin, TX location and is not remote', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());
    const job = jobs[0];

    expect(job.location?.city).toBe('Austin');
    expect(job.location?.state).toBe('TX');
    expect(job.isRemote).toBe(false);
  });

  it('maps the stated Full-time employment type to FULL_TIME', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());
    const job = jobs[0];

    expect(job.employmentType).toBe('Full-time');
    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    expect(job.department).toBe('Engineering');
  });

  it('carries the inline JD sections into the description as markdown', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());
    const description = jobs[0].description ?? '';

    expect(description).toBeTruthy();
    expect(description).toMatch(/Job Summary/i);
    expect(description).toMatch(/Key Responsibilities/i);
    expect(description).toMatch(/Desired Qualifications/i);
    expect(description).toMatch(/power transformer/i);
  });

  it('applies searchTerm / offset / resultsWanted filters', async () => {
    const svc = makeService();

    const match = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'transformer' }),
    );
    expect(match.jobs.length).toBe(1);

    const miss = await svc.scrape(
      new ScraperInputDto({ searchTerm: 'nonexistent-role-xyz' }),
    );
    expect(miss.jobs.length).toBe(0);

    const offset = await svc.scrape(
      new ScraperInputDto({ offset: 1, resultsWanted: 10 }),
    );
    expect(offset.jobs.length).toBe(0);
  });

  it('returns nothing (no throw) when the careers page has no role cards', async () => {
    const svc = makeService(EMPTY);
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
