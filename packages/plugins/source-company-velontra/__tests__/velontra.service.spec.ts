import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { VelontraService } from '../src/velontra.service';

const FIXTURES = join(__dirname, 'fixtures');
const LISTING_HTML = readFileSync(join(FIXTURES, 'careers.html'), 'utf8');

/** Access the protected fetch seam without loosening it to `any`. */
interface Seams {
  fetchListingHtml: (client: unknown) => Promise<string>;
}

function serviceWith(html: string = LISTING_HTML): VelontraService {
  const service = new VelontraService();
  const seams = service as unknown as Seams;
  jest.spyOn(seams, 'fetchListingHtml').mockResolvedValue(html);
  return service;
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), overrides);
}

describe('VelontraService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses the four inline accordion roles', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    expect(jobs).toHaveLength(4);
    expect(jobs.map((j) => j.title)).toEqual([
      'Propulsion Responsible Engineer',
      'Principal Turbomachinery Engineer',
      'Senior Turbomachinery Engineer',
      'Turbomachinery Engineer',
    ]);
  });

  it('maps identity, shared apply form, and null location/date per role', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const role = jobs.find((j) => j.title === 'Propulsion Responsible Engineer')!;
    expect(role.site).toBe(Site.VELONTRA);
    expect(role.id).toBe('velontra-propulsion-responsible-engineer');
    expect(role.companyName).toBe('Velontra');
    expect(role.jobUrl).toBe('https://velontra.com/careers/');
    expect(role.applyUrl).toBe('https://velontra.com/apply/');
    expect(role.emails).toEqual([]);
    expect(role.location ?? null).toBeNull();
    expect(role.datePosted).toBeNull();
    expect(role.compensation ?? null).toBeNull();
  });

  it('carries the panel prose into the description, dropping the "Job Title:" heading', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const role = jobs.find((j) => j.title === 'Propulsion Responsible Engineer')!;
    expect(role.description).toContain('Responsibilities');
    expect(role.description).toContain('Qualifications');
    expect(role.description).toContain('propulsion');
    expect(role.description).not.toContain('Job Title:');
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    const filtered = await serviceWith().scrape(
      inputFrom({ searchTerm: 'Principal' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Principal Turbomachinery Engineer');

    const capped = await serviceWith().scrape(inputFrom({ resultsWanted: 2 }));
    expect(capped.jobs).toHaveLength(2);
  });

  it('returns empty (no throw) when the page has no accordions', async () => {
    const { jobs } = await serviceWith('<html><body></body></html>').scrape(
      inputFrom(),
    );
    expect(jobs).toHaveLength(0);
  });
});
