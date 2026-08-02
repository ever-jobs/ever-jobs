import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { SpikeaerospaceService } from '../src/spikeaerospace.service';
import { WpPost } from '../src/spikeaerospace.types';

const FIXTURES = join(__dirname, 'fixtures');
const POSTS: WpPost[] = JSON.parse(
  readFileSync(join(FIXTURES, 'current-openings.json'), 'utf8'),
);

interface Seams {
  fetchRolePosts: () => Promise<WpPost[]>;
}

function makeService(posts: WpPost[] = POSTS): SpikeaerospaceService {
  const svc = new SpikeaerospaceService();
  (svc as unknown as Seams).fetchRolePosts = async () => posts;
  return svc;
}

describe('SpikeaerospaceService', () => {
  it('maps every Current Openings post to a job', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    // 9 roles in the "Current Openings" category at capture time
    expect(jobs.length).toBe(9);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    for (const job of jobs) {
      expect(job.site).toBe(Site.SPIKEAEROSPACE);
      expect(job.companyName).toBe('Spike Aerospace');
      expect(job.id ?? '').toMatch(/^spikeaerospace-/);
      expect(job.jobUrl).toMatch(/^https:\/\/www\.spikeaerospace\.com\//);
      // applying is an on-page form: no email, no external apply URL
      expect(job.emails).toEqual([]);
    }
  });

  it('includes roles that exist only as posts (not linked from the listing)', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const cad = jobs.find((j) => j.id === 'spikeaerospace-experienced-cad-engineer');
    const writer = jobs.find(
      (j) => j.id === 'spikeaerospace-seeking-creative-storytelling-writer',
    );
    expect(cad).toBeDefined();
    expect(writer).toBeDefined();
  });

  it('populates datePosted from the post publish date (calendar day)', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const structural = jobs.find(
      (j) => j.id === 'spikeaerospace-senior-structural-engineer',
    );
    expect(structural?.datePosted).toBe('2024-10-22');

    for (const job of jobs) {
      expect(job.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('decodes titles and drops the leading "Seeking" listing verb', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const stability = jobs.find(
      (j) => j.id === 'spikeaerospace-senior-stability-controls-engineer',
    );
    // &#038; decoded to & ...
    expect(stability?.title).toBe('Senior Stability & Controls Engineer');

    const config = jobs.find(
      (j) => j.id === 'spikeaerospace-seeking-aircraft-configuration-engineer',
    );
    // ... and the "Seeking " prefix removed
    expect(config?.title).toBe('Aircraft Configuration Engineer');
  });

  it('carries the post body into the description without the form artifacts', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    const hr = jobs.find(
      (j) => j.id === 'spikeaerospace-seeking-human-resource-specialist',
    );
    expect(hr?.description).toBeTruthy();
    expect(hr?.description).toMatch(/Responsibilities/i);
    // the CF7 placeholder and dangling form label are stripped
    expect(hr?.description ?? '').not.toMatch(/contact form not found/i);
    expect(hr?.description ?? '').not.toMatch(/^submit your resume:?$/im);
  });

  it('leaves the location unset when the site lists none', async () => {
    const svc = makeService();
    const { jobs } = await svc.scrape(new ScraperInputDto());

    for (const job of jobs) {
      expect(job.location).toBeNull();
    }
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

  it('returns empty (no throw) when the category has no posts', async () => {
    const svc = makeService([]);
    const { jobs } = await svc.scrape(new ScraperInputDto());
    expect(jobs).toEqual([]);
  });
});
