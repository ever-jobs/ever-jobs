import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { PluginRegistry } from '@ever-jobs/plugin';
import { SmartRecruitersService } from '@ever-jobs/source-ats-smartrecruiters';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: jest.fn(),
      setHeaders: jest.fn(),
    })),
  };
});

import { CityAndCountyOfSanFranciscoModule, CityAndCountyOfSanFranciscoService } from '../src';

const COMPANY_NAME_EXPECT = 'City and County of San Francisco';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
// SmartRecruiters' public Posting API returns a { content: [...] } envelope.
const JOBS_ENVELOPE_RAW: { content: any[] } = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'cityandcountyofsanfrancisco-jobs.json'), 'utf8'),
);
const JOBS_RAW: any[] = JOBS_ENVELOPE_RAW.content;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Registry wired with a real SmartRecruitersService under Site.SMARTRECRUITERS. */
function registryWithSmartRecruiters(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(
    { site: Site.SMARTRECRUITERS, name: 'SmartRecruiters', category: 'ats', isAts: true },
    new SmartRecruitersService(),
  );
  return registry;
}

describe('CityAndCountyOfSanFranciscoService — SmartRecruiters delegation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through CityAndCountyOfSanFranciscoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CityAndCountyOfSanFranciscoModule],
      }).compile();
      const service = moduleRef.get(CityAndCountyOfSanFranciscoService);
      expect(service).toBeInstanceOf(CityAndCountyOfSanFranciscoService);
      await moduleRef.close();
    });

    it('exports the Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO = "cityandcountyofsanfrancisco" enum value', () => {
      expect(Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO).toBe('cityandcountyofsanfrancisco');
    });
  });

  describe('happy path (delegates to the registered SmartRecruiters plugin)', () => {
    it('maps all fixture listings to JobPostDto with the company identity', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });

      const service = new CityAndCountyOfSanFranciscoService(registryWithSmartRecruiters());
      const result = (await service.scrape({
        siteType: [Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO],
        resultsWanted: 100,
      } as ScraperInputDto)) as JobResponseDto;

      expect(result.jobs).toHaveLength(JOBS_RAW.length);

      const first = JOBS_RAW[0];
      const job0 = result.jobs.find(
        (j) => j.id === 'cityandcountyofsanfrancisco-' + first.id,
      );
      expect(job0).toBeDefined();
      // company identity is re-stamped over SmartRecruiters' defaults
      expect(job0?.site).toBe(Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO);
      expect(job0?.companyName).toBe(COMPANY_NAME_EXPECT);
      expect(job0?.id).toBe('cityandcountyofsanfrancisco-' + first.id);
      expect(job0?.id?.startsWith('sr-')).toBe(false);
      // SmartRecruiters-mapped fields flow through untouched
      expect(job0?.title).toBe(first.name);
      expect(job0?.jobUrl).toBe(first.ref);
      expect(job0?.department).toBe(first.department.label);

      // it hit the SmartRecruiters board for the company slug, not GH/Lever/Ashby
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toContain('api.smartrecruiters.com');
      expect(calledUrls[0]).toContain('cityandcountyofsanfrancisco1');
      expect(calledUrls[0]).not.toContain('greenhouse');
      expect(calledUrls[0]).not.toContain('lever');
    });

    it('every job carries the company site, companyName, and id prefix', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });
      const service = new CityAndCountyOfSanFranciscoService(registryWithSmartRecruiters());
      const result = await service.scrape({
        siteType: [Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO);
        expect(job.companyName).toBe(COMPANY_NAME_EXPECT);
        expect(job.id?.startsWith('cityandcountyofsanfrancisco-')).toBe(true);
      }
    });
  });

  describe('input pass-through', () => {
    it('forwards the company slug and caller input to the SmartRecruiters scraper', async () => {
      const captured: ScraperInputDto[] = [];
      const fakeSr: IScraper = {
        scrape: async (input) => {
          captured.push(input);
          return new JobResponseDto([
            new JobPostDto({ id: 'sr-x1', title: 'Role', jobUrl: 'u' }),
          ]);
        },
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.SMARTRECRUITERS, name: 'SmartRecruiters', category: 'ats', isAts: true },
        fakeSr,
      );

      const service = new CityAndCountyOfSanFranciscoService(registry);
      const result = await service.scrape({
        siteType: [Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO],
        resultsWanted: 7,
      } as ScraperInputDto);

      expect(captured).toHaveLength(1);
      expect(captured[0].companySlug).toBe('cityandcountyofsanfrancisco1');
      expect(captured[0].resultsWanted).toBe(7);
      expect(result.jobs[0].id).toBe('cityandcountyofsanfrancisco-x1');
      expect(result.jobs[0].site).toBe(Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO);
    });

    it('only rewrites a leading sr- id prefix', async () => {
      const fakeSr: IScraper = {
        scrape: async () =>
          new JobResponseDto([
            new JobPostDto({ id: 'sr-sr-7', title: 'T', jobUrl: 'u' }),
          ]),
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.SMARTRECRUITERS, name: 'SmartRecruiters', category: 'ats', isAts: true },
        fakeSr,
      );
      const service = new CityAndCountyOfSanFranciscoService(registry);
      const result = await service.scrape({
        siteType: [Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO],
      } as ScraperInputDto);
      expect(result.jobs[0].id).toBe('cityandcountyofsanfrancisco-sr-7');
    });
  });

  describe('resilience', () => {
    it('returns an empty response when no SmartRecruiters plugin is registered', async () => {
      const service = new CityAndCountyOfSanFranciscoService(new PluginRegistry());
      const result = await service.scrape({
        siteType: [Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });

    it('returns an empty response when no registry is injected', async () => {
      const service = new CityAndCountyOfSanFranciscoService();
      const result = await service.scrape({
        siteType: [Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that distinguishes a wiring fault from an empty board.
      expect(result.diagnostics?.reason).toBe('not_registered');
      expect(result.diagnostics?.detail).toContain('SmartRecruiters');
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against the fixture page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });
      const service = new CityAndCountyOfSanFranciscoService(registryWithSmartRecruiters());
      const result = await service.scrape({
        siteType: [Site.CITY_AND_COUNTY_OF_SAN_FRANCISCO],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });
});
