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

import { PlatinumHealthcareStaffingModule, PlatinumHealthcareStaffingService } from '../src';

const COMPANY_NAME_EXPECT = 'Platinum Healthcare Staffing';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
// SmartRecruiters' public Posting API returns a { content: [...] } envelope.
const JOBS_ENVELOPE_RAW: { content: any[] } = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'platinumhealthcarestaffing-jobs.json'), 'utf8'),
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

describe('PlatinumHealthcareStaffingService — SmartRecruiters delegation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through PlatinumHealthcareStaffingModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PlatinumHealthcareStaffingModule],
      }).compile();
      const service = moduleRef.get(PlatinumHealthcareStaffingService);
      expect(service).toBeInstanceOf(PlatinumHealthcareStaffingService);
      await moduleRef.close();
    });

    it('exports the Site.PLATINUM_HEALTHCARE_STAFFING = "platinumhealthcarestaffing" enum value', () => {
      expect(Site.PLATINUM_HEALTHCARE_STAFFING).toBe('platinumhealthcarestaffing');
    });
  });

  describe('happy path (delegates to the registered SmartRecruiters plugin)', () => {
    it('maps all fixture listings to JobPostDto with the company identity', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });

      const service = new PlatinumHealthcareStaffingService(registryWithSmartRecruiters());
      const result = (await service.scrape({
        siteType: [Site.PLATINUM_HEALTHCARE_STAFFING],
        resultsWanted: 100,
      } as ScraperInputDto)) as JobResponseDto;

      expect(result.jobs).toHaveLength(JOBS_RAW.length);

      const first = JOBS_RAW[0];
      const job0 = result.jobs.find(
        (j) => j.id === 'platinumhealthcarestaffing-' + first.id,
      );
      expect(job0).toBeDefined();
      // company identity is re-stamped over SmartRecruiters' defaults
      expect(job0?.site).toBe(Site.PLATINUM_HEALTHCARE_STAFFING);
      expect(job0?.companyName).toBe(COMPANY_NAME_EXPECT);
      expect(job0?.id).toBe('platinumhealthcarestaffing-' + first.id);
      expect(job0?.id?.startsWith('sr-')).toBe(false);
      // SmartRecruiters-mapped fields flow through untouched
      expect(job0?.title).toBe(first.name);
      expect(job0?.jobUrl).toBe(first.ref);
      expect(job0?.department).toBe(first.department.label);

      // it hit the SmartRecruiters board for the company slug, not GH/Lever/Ashby
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toContain('api.smartrecruiters.com');
      expect(calledUrls[0]).toContain('PlatinumHealthcareStaffingInc');
      expect(calledUrls[0]).not.toContain('greenhouse');
      expect(calledUrls[0]).not.toContain('lever');
    });

    it('every job carries the company site, companyName, and id prefix', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });
      const service = new PlatinumHealthcareStaffingService(registryWithSmartRecruiters());
      const result = await service.scrape({
        siteType: [Site.PLATINUM_HEALTHCARE_STAFFING],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.PLATINUM_HEALTHCARE_STAFFING);
        expect(job.companyName).toBe(COMPANY_NAME_EXPECT);
        expect(job.id?.startsWith('platinumhealthcarestaffing-')).toBe(true);
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

      const service = new PlatinumHealthcareStaffingService(registry);
      const result = await service.scrape({
        siteType: [Site.PLATINUM_HEALTHCARE_STAFFING],
        resultsWanted: 7,
      } as ScraperInputDto);

      expect(captured).toHaveLength(1);
      expect(captured[0].companySlug).toBe('PlatinumHealthcareStaffingInc');
      expect(captured[0].resultsWanted).toBe(7);
      expect(result.jobs[0].id).toBe('platinumhealthcarestaffing-x1');
      expect(result.jobs[0].site).toBe(Site.PLATINUM_HEALTHCARE_STAFFING);
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
      const service = new PlatinumHealthcareStaffingService(registry);
      const result = await service.scrape({
        siteType: [Site.PLATINUM_HEALTHCARE_STAFFING],
      } as ScraperInputDto);
      expect(result.jobs[0].id).toBe('platinumhealthcarestaffing-sr-7');
    });
  });

  describe('resilience', () => {
    it('returns an empty response when no SmartRecruiters plugin is registered', async () => {
      const service = new PlatinumHealthcareStaffingService(new PluginRegistry());
      const result = await service.scrape({
        siteType: [Site.PLATINUM_HEALTHCARE_STAFFING],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });

    it('returns an empty response when no registry is injected', async () => {
      const service = new PlatinumHealthcareStaffingService();
      const result = await service.scrape({
        siteType: [Site.PLATINUM_HEALTHCARE_STAFFING],
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
      const service = new PlatinumHealthcareStaffingService(registryWithSmartRecruiters());
      const result = await service.scrape({
        siteType: [Site.PLATINUM_HEALTHCARE_STAFFING],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });
});
