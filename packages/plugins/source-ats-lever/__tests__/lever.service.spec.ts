/**
 * Unit tests for the Lever field mappings added in spec 752:
 * compensation, department, multi-location, workFromHomeType, and the ISO-2
 * country fold-in. Drives the public scraping path with a mocked HTTP client.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ScraperInputDto,
  Site,
  CompensationInterval,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: mockSetHeaders,
    })),
  };
});

import { LeverModule, LeverService } from '@ever-jobs/source-ats-lever';
import {
  ATS_COUNTRY_OVERLAY_ENV_VAR,
  readAtsCountryOverlay,
} from '../src/lever.constants';

async function scrapeOne(job: Record<string, unknown>) {
  mockGet.mockResolvedValueOnce({ data: [job] });
  const module: TestingModule = await Test.createTestingModule({
    imports: [LeverModule],
  }).compile();
  const service = module.get<LeverService>(LeverService);
  const input = new ScraperInputDto({
    siteType: [Site.LEVER],
    companySlug: 'crgo',
    resultsWanted: 5,
  });
  const response = await service.scrape(input);
  expect(response.jobs).toHaveLength(1);
  return response.jobs[0];
}

describe('LeverService field mappings (spec 752)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    delete process.env.LEVER_API_KEY;
  });

  it('should map salaryRange to compensation honoring the real interval', async () => {
    const job = await scrapeOne({
      id: 'comp-hourly',
      text: 'Machinist',
      salaryRange: {
        min: 20.14,
        max: 24.9,
        currency: 'USD',
        interval: 'per-hour-wage',
      },
    });

    expect(job.compensation).toBeDefined();
    expect(job.compensation?.interval).toBe(CompensationInterval.HOURLY);
    expect(job.compensation?.minAmount).toBe(20.14);
    expect(job.compensation?.maxAmount).toBe(24.9);
    expect(job.compensation?.currency).toBe('USD');
  });

  it('should resolve per-year and per-month interval tokens', async () => {
    const yearly = await scrapeOne({
      id: 'comp-yearly',
      text: 'Engineer',
      salaryRange: { min: 120000, max: 160000, currency: 'USD', interval: 'per-year-salary' },
    });
    expect(yearly.compensation?.interval).toBe(CompensationInterval.YEARLY);

    const monthly = await scrapeOne({
      id: 'comp-monthly',
      text: 'Contractor',
      salaryRange: { min: 8000, max: 9000, currency: 'USD', interval: 'per-month-salary' },
    });
    expect(monthly.compensation?.interval).toBe(CompensationInterval.MONTHLY);
  });

  it('should leave compensation null when no salaryRange is present', async () => {
    const job = await scrapeOne({ id: 'no-comp', text: 'Role' });
    expect(job.compensation).toBeNull();
  });

  it('should fall back to the description salary when salaryRange is absent (Spec 5018)', async () => {
    const job = await scrapeOne({
      id: 'comp-text',
      text: 'Engineer',
      descriptionPlain:
        'We offer a base salary of $120,000 - $160,000 per year plus equity.',
    });
    expect(job.compensation).toBeDefined();
    expect(job.compensation?.minAmount).toBe(120000);
    expect(job.compensation?.maxAmount).toBe(160000);
    expect(job.compensation?.currency).toBe('USD');
  });

  it('should prefer structured salaryRange over a description salary (Spec 5018)', async () => {
    const job = await scrapeOne({
      id: 'comp-both',
      text: 'Engineer',
      salaryRange: { min: 90000, max: 100000, currency: 'EUR', interval: 'per-year-salary' },
      descriptionPlain: 'Range listed in body: $120,000 - $160,000 per year.',
    });
    expect(job.compensation?.minAmount).toBe(90000);
    expect(job.compensation?.maxAmount).toBe(100000);
    expect(job.compensation?.currency).toBe('EUR');
  });

  it('should leave compensation null when neither structured nor text has a salary (Spec 5018)', async () => {
    const job = await scrapeOne({
      id: 'comp-none',
      text: 'Engineer',
      descriptionPlain: 'A great team working on hard problems. 5+ years required.',
    });
    expect(job.compensation).toBeNull();
  });

  it('should map categories.department independently of team', async () => {
    const job = await scrapeOne({
      id: 'dept',
      text: 'CNC Operator',
      categories: { department: 'Manufacturing', team: 'CNC' },
    });
    expect(job.department).toBe('Manufacturing');
    expect(job.team).toBe('CNC');
  });

  it('should join multi-site allLocations into a single location', async () => {
    const job = await scrapeOne({
      id: 'multi',
      text: 'Technician',
      categories: {
        location: 'Nashua, NH',
        allLocations: ['Nashua, NH', 'Brooklyn Park, MN'],
      },
    });
    expect(job.location?.city).toBe('Nashua, NH; Brooklyn Park, MN');
    expect(job.locations).toMatchObject([
      { city: 'Nashua', state: 'NH' },
      { city: 'Brooklyn Park', state: 'MN' },
    ]);
  });

  it('should emit a per-site locations[] even when a label does not parse', async () => {
    const job = await scrapeOne({
      id: 'multi-unparsed',
      text: 'Technician',
      categories: {
        allLocations: ['Berlin, Germany', 'Austin, TX'],
      },
    });
    // Each allLocations label lands as its own locations[] entry.
    expect(job.locations).toMatchObject([
      { city: 'Berlin', country: 'Germany' },
      { city: 'Austin', state: 'TX' },
    ]);
  });

  it('should set workFromHomeType Hybrid without marking the job remote', async () => {
    const job = await scrapeOne({
      id: 'hybrid',
      text: 'Designer',
      categories: { location: 'Austin, TX' },
      workplaceType: 'hybrid',
    });
    expect(job.workFromHomeType).toBe('Hybrid');
    expect(job.isRemote).toBe(false);
  });

  it('should set Remote and isRemote from workplaceType remote', async () => {
    const job = await scrapeOne({
      id: 'remote',
      text: 'SRE',
      categories: { location: 'San Francisco, CA' },
      workplaceType: 'remote',
    });
    expect(job.workFromHomeType).toBe('Remote');
    expect(job.isRemote).toBe(true);
  });

  it('should pass an unresolvable country code through verbatim', async () => {
    const job = await scrapeOne({
      id: 'bad-country',
      text: 'Operator',
      categories: { location: 'Nashua, NH' },
      country: 'QZ',
    });
    expect(job.countryCode).toBe('QZ');
    expect(job.location?.city).toBe('Nashua');
    expect(job.location?.state).toBe('NH');
    expect(job.location?.country).toBeFalsy();
  });

  /**
   * Spec 1689 — Spec 5118 removed the country fold-in; it is restored as the
   * default and can be switched off with EVER_JOBS_ATS_COUNTRY_OVERLAY=false.
   */
  describe('ATS country overlay (Spec 1689)', () => {
    const ENV = ATS_COUNTRY_OVERLAY_ENV_VAR;
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[ENV];
      delete process.env[ENV];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    });

    it('is ON by default: folds a non-US ISO-2 code into a country-less location', async () => {
      const job = await scrapeOne({
        id: 'country',
        text: 'Operator',
        categories: { location: 'Amsterdam' },
        country: 'NL',
      });
      expect(job.location?.city).toBe('Amsterdam');
      expect(job.location?.country).toBe('Netherlands');
      // The single-site locations[] agrees with location.
      expect(job.locations).toMatchObject([{ city: 'Amsterdam', country: 'Netherlands' }]);
      // countryCode is still emitted, verbatim.
      expect(job.countryCode).toBe('NL');
    });

    it('fills a location when the parser found none', async () => {
      const job = await scrapeOne({ id: 'no-loc', text: 'Operator', country: 'DE' });
      expect(job.location?.country).toBe('Germany');
      expect(job.locations ?? []).toEqual([]);
      expect(job.countryCode).toBe('DE');
    });

    it('never overwrites a country the parser found', async () => {
      const job = await scrapeOne({
        id: 'keep-country',
        text: 'Operator',
        categories: { location: 'Berlin, Germany' },
        country: 'NL',
      });
      expect(job.location?.country).toBe('Germany');
      expect(job.countryCode).toBe('NL');
    });

    it('fills the merged location but leaves a multi-site locations[] as parsed', async () => {
      const job = await scrapeOne({
        id: 'multi-country',
        text: 'Technician',
        categories: { allLocations: ['Amsterdam', 'Rotterdam'] },
        country: 'NL',
      });
      expect(job.location?.country).toBe('Netherlands');
      expect(job.locations).toHaveLength(2);
      for (const site of job.locations ?? []) expect(site.country).toBeFalsy();
    });

    it.each(['false', 'FALSE', '0', 'no', 'off'])(
      'is OFF when %s: the code goes to countryCode only (Spec 5118)',
      async (value) => {
        process.env[ENV] = value;
        const job = await scrapeOne({
          id: 'country-off',
          text: 'Operator',
          categories: { location: 'Amsterdam' },
          country: 'NL',
        });
        expect(job.countryCode).toBe('NL');
        expect(job.location?.city).toBe('Amsterdam');
        expect(job.location?.country).toBeFalsy();
        expect(job.locations?.[0]?.country).toBeFalsy();
      },
    );

    it('treats an unrecognised value as ON', async () => {
      process.env[ENV] = 'maybe';
      const job = await scrapeOne({
        id: 'country-weird',
        text: 'Operator',
        categories: { location: 'Amsterdam' },
        country: 'NL',
      });
      expect(job.location?.country).toBe('Netherlands');
    });

    it('readAtsCountryOverlay parses the env var', () => {
      expect(readAtsCountryOverlay({})).toBe(true);
      expect(readAtsCountryOverlay({ [ENV]: '' })).toBe(true);
      expect(readAtsCountryOverlay({ [ENV]: 'true' })).toBe(true);
      expect(readAtsCountryOverlay({ [ENV]: ' Off ' })).toBe(false);
    });
  });
});
