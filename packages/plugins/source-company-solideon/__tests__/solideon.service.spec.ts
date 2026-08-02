import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CompensationInterval, ScraperInputDto, Site } from '@ever-jobs/models';
import { SolideonService } from '../src/solideon.service';

const FIXTURES = join(__dirname, 'fixtures');
const read = (name: string): string =>
  readFileSync(join(FIXTURES, name), 'utf8');

const CAREERS = read('careers.html');
const DETAIL: Record<string, string> = {
  'https://solideon.com/solideon-cnc-robot-operator': read(
    'solideon-cnc-robot-operator.html',
  ),
  'https://solideon.com/solideon-sensor-fusion-software-engineer': read(
    'solideon-sensor-fusion-software-engineer.html',
  ),
  'https://solideon.com/solideon-applications-engineer': read(
    'solideon-applications-engineer.html',
  ),
  'https://solideon.com/solideon-manufacturing-engineer': read(
    'solideon-manufacturing-engineer.html',
  ),
};

interface Seams {
  fetchHtml: (client: unknown, url: string) => Promise<string>;
}

function serviceWith(
  careers: string = CAREERS,
  detail: Record<string, string> = DETAIL,
): SolideonService {
  const service = new SolideonService();
  const seams = service as unknown as Seams;
  jest
    .spyOn(seams, 'fetchHtml')
    .mockImplementation(async (_client: unknown, url: string) =>
      url.endsWith('/careers/') ? careers : (detail[url] ?? ''),
    );
  return service;
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), overrides);
}

describe('SolideonService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('enumerates the four openings from the careers listing', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    expect(jobs.map((j) => j.title).sort()).toEqual([
      'Applications Engineer',
      'CNC & Robot Operator',
      'Manufacturing Engineer',
      'Sensor Fusion Software Engineer',
    ]);
  });

  it('maps identity, per-role apply page, and detail-page date', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const cnc = jobs.find((j) => j.title === 'CNC & Robot Operator')!;
    expect(cnc.site).toBe(Site.SOLIDEON);
    expect(cnc.id).toBe('solideon-cnc-robot-operator');
    expect(cnc.companyName).toBe('Solideon');
    expect(cnc.jobUrl).toBe('https://solideon.com/solideon-cnc-robot-operator');
    expect(cnc.applyUrl).toBe(cnc.jobUrl);
    expect(cnc.emails).toEqual([]);
    expect(cnc.isRemote).toBe(false);
    expect(String(cnc.datePosted)).toContain('2025-04-24');
  });

  it('uses each role stated location, including the non-Berkeley role', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const cnc = jobs.find((j) => j.title === 'CNC & Robot Operator')!;
    const mfg = jobs.find((j) => j.title === 'Manufacturing Engineer')!;
    expect(cnc.location?.displayLocation()).toContain('Berkeley');
    expect(mfg.location?.displayLocation()).toContain('Hampton Roads');
    expect(mfg.location?.displayLocation()).not.toContain('Berkeley');
  });

  it('populates compensation where stated and omits it where absent', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const cnc = jobs.find((j) => j.title === 'CNC & Robot Operator')!;
    expect(cnc.compensation).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 80000,
      maxAmount: 100000,
      currency: 'USD',
    });
    const sensor = jobs.find(
      (j) => j.title === 'Sensor Fusion Software Engineer',
    )!;
    expect(sensor.compensation).toMatchObject({
      minAmount: 125000,
      maxAmount: 175000,
    });
    const appEng = jobs.find((j) => j.title === 'Applications Engineer')!;
    expect(appEng.compensation ?? null).toBeNull();
  });

  it('carries the JD body into the description without the apply form', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const cnc = jobs.find((j) => j.title === 'CNC & Robot Operator')!;
    expect(cnc.description).toContain('Responsibilities');
    expect(cnc.description).toContain('Qualifications');
    expect(cnc.description).not.toMatch(/fill out the form below/i);
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    const filtered = await serviceWith().scrape(
      inputFrom({ searchTerm: 'Sensor Fusion' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Sensor Fusion Software Engineer');

    const capped = await serviceWith().scrape(inputFrom({ resultsWanted: 2 }));
    expect(capped.jobs).toHaveLength(2);
  });

  it('returns empty (no throw) when the listing has no role links', async () => {
    const { jobs } = await serviceWith(
      '<html><body><a href="https://solideon.com/about/">About</a></body></html>',
      {},
    ).scrape(inputFrom());
    expect(jobs).toHaveLength(0);
  });
});
