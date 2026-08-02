import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { GaladyneIoService } from '../src/galadyne_io.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, name), 'utf8');

const CAREERS = read('careers.html');
const CHUNK = read('careers-chunk.js');

interface Seams {
  fetchText: (client: unknown, url: string) => Promise<string>;
}

function serviceWith(
  careers: string = CAREERS,
  chunk: string = CHUNK,
): GaladyneIoService {
  const service = new GaladyneIoService();
  const seams = service as unknown as Seams;
  jest
    .spyOn(seams, 'fetchText')
    .mockImplementation(async (_client: unknown, url: string) =>
      url.endsWith('/careers') ? careers : chunk,
    );
  return service;
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), overrides);
}

describe('GaladyneIoService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('enumerates every posting, including the general internship', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    expect(jobs.map((j) => j.title).sort()).toEqual([
      'Flight Software Engineer',
      'General Internship Application',
      'Integration Technician (All Levels)',
      'Propulsion Engineer',
      'Structures Engineer',
    ]);
  });

  it('maps identity, stated location, and on-page apply page', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const prop = jobs.find((j) => j.title === 'Propulsion Engineer')!;
    expect(prop.site).toBe(Site.GALADYNE_IO);
    expect(prop.id).toBe('galadyne_io-propulsion-engineer');
    expect(prop.companyName).toBe('Galadyne');
    expect(prop.jobUrl).toBe('https://www.galadyne.io/careers');
    expect(prop.applyUrl).toBe('https://www.galadyne.io/careers');
    expect(prop.location?.displayLocation()).toContain('Austin');
    expect(prop.isRemote).toBe(false);
    expect(prop.datePosted ?? null).toBeNull();
    expect(prop.emails).toEqual([]);
    expect(prop.compensation ?? null).toBeNull();
  });

  it('builds the JD description from the client chunk content', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const prop = jobs.find((j) => j.title === 'Propulsion Engineer')!;
    expect(prop.description).toContain('liquid rocket engines');
    expect(prop.description).toContain('**Responsibilities**');
    expect(prop.description).toContain('**Qualifications**');
    expect(prop.description).toContain('2+ years of hands-on experience');
    // slugs with parentheses normalize cleanly
    const tech = jobs.find(
      (j) => j.title === 'Integration Technician (All Levels)',
    )!;
    expect(tech.id).toBe('galadyne_io-integration-technician-all-levels');
  });

  it('still yields the listing roles when the chunk is unavailable', async () => {
    const { jobs } = await serviceWith(CAREERS, '').scrape(inputFrom());
    expect(jobs).toHaveLength(5);
    expect(jobs.every((j) => j.description === null)).toBe(true);
    expect(jobs.every((j) => j.location?.displayLocation()?.includes('Austin'))).toBe(
      true,
    );
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    const filtered = await serviceWith().scrape(
      inputFrom({ searchTerm: 'Flight Software' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Flight Software Engineer');

    const capped = await serviceWith().scrape(inputFrom({ resultsWanted: 2 }));
    expect(capped.jobs).toHaveLength(2);
  });

  it('returns empty (no throw) when the listing has no cards', async () => {
    const { jobs } = await serviceWith(
      '<html><body><p>No openings</p></body></html>',
      '',
    ).scrape(inputFrom());
    expect(jobs).toHaveLength(0);
  });
});
