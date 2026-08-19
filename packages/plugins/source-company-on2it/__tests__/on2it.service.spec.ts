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
import { RecruiteeService } from '@ever-jobs/source-ats-recruitee';

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

import { ON2ITModule, ON2ITService } from '../src';

const COMPANY_NAME_EXPECT = 'ON2IT';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
// Recruitee's public careers API returns an { offers: [...] } envelope.
const JOBS_ENVELOPE_RAW: { offers: any[] } = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'on2it-jobs.json'), 'utf8'),
);
const JOBS_RAW: any[] = JOBS_ENVELOPE_RAW.offers;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Registry wired with a real RecruiteeService under Site.RECRUITEE. */
function registryWithRecruitee(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(
    { site: Site.RECRUITEE, name: 'Recruitee', category: 'ats', isAts: true },
    new RecruiteeService(),
  );
  return registry;
}

describe('ON2ITService — Recruitee delegation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ON2ITModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ON2ITModule],
      }).compile();
      const service = moduleRef.get(ON2ITService);
      expect(service).toBeInstanceOf(ON2ITService);
      await moduleRef.close();
    });

    it('exports the Site.ON2IT = "on2it" enum value', () => {
      expect(Site.ON2IT).toBe('on2it');
    });
  });

  describe('happy path (delegates to the registered Recruitee plugin)', () => {
    it('maps all fixture offers to JobPostDto with the company identity', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });

      const service = new ON2ITService(registryWithRecruitee());
      const result = (await service.scrape({
        siteType: [Site.ON2IT],
        resultsWanted: 100,
      } as ScraperInputDto)) as JobResponseDto;

      expect(result.jobs).toHaveLength(JOBS_RAW.length);

      const first = JOBS_RAW[0];
      const job0 = result.jobs.find(
        (j) => j.id === 'on2it-' + first.id,
      );
      expect(job0).toBeDefined();
      // company identity is re-stamped over Recruitee's defaults
      expect(job0?.site).toBe(Site.ON2IT);
      expect(job0?.companyName).toBe(COMPANY_NAME_EXPECT);
      expect(job0?.id).toBe('on2it-' + first.id);
      expect(job0?.id?.startsWith('recruitee-')).toBe(false);
      // Recruitee-mapped fields flow through untouched
      expect(job0?.title).toBe(first.title);
      expect(job0?.jobUrl).toBe(first.careers_url + '/' + first.slug);
      expect(job0?.department).toBe(first.department);

      // it hit the Recruitee board for the company slug, not GH/Lever/Ashby/SR
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toContain('on2it.recruitee.com');
      expect(calledUrls[0]).not.toContain('greenhouse');
      expect(calledUrls[0]).not.toContain('lever');
      expect(calledUrls[0]).not.toContain('smartrecruiters');
    });

    it('every job carries the company site, companyName, and id prefix', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });
      const service = new ON2ITService(registryWithRecruitee());
      const result = await service.scrape({
        siteType: [Site.ON2IT],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.ON2IT);
        expect(job.companyName).toBe(COMPANY_NAME_EXPECT);
        expect(job.id?.startsWith('on2it-')).toBe(true);
      }
    });
  });

  describe('input pass-through', () => {
    it('forwards the company slug and caller input to the Recruitee scraper', async () => {
      const captured: ScraperInputDto[] = [];
      const fakeRecruitee: IScraper = {
        scrape: async (input) => {
          captured.push(input);
          return new JobResponseDto([
            new JobPostDto({ id: 'recruitee-x1', title: 'Role', jobUrl: 'u' }),
          ]);
        },
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.RECRUITEE, name: 'Recruitee', category: 'ats', isAts: true },
        fakeRecruitee,
      );

      const service = new ON2ITService(registry);
      const result = await service.scrape({
        siteType: [Site.ON2IT],
        resultsWanted: 7,
      } as ScraperInputDto);

      expect(captured).toHaveLength(1);
      expect(captured[0].companySlug).toBe('on2it');
      expect(captured[0].resultsWanted).toBe(7);
      expect(result.jobs[0].id).toBe('on2it-x1');
      expect(result.jobs[0].site).toBe(Site.ON2IT);
    });

    it('only rewrites a leading recruitee- id prefix', async () => {
      const fakeRecruitee: IScraper = {
        scrape: async () =>
          new JobResponseDto([
            new JobPostDto({ id: 'recruitee-recruitee-7', title: 'T', jobUrl: 'u' }),
          ]),
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.RECRUITEE, name: 'Recruitee', category: 'ats', isAts: true },
        fakeRecruitee,
      );
      const service = new ON2ITService(registry);
      const result = await service.scrape({
        siteType: [Site.ON2IT],
      } as ScraperInputDto);
      expect(result.jobs[0].id).toBe('on2it-recruitee-7');
    });
  });

  describe('resilience', () => {
    it('returns an empty response when no Recruitee plugin is registered', async () => {
      const service = new ON2ITService(new PluginRegistry());
      const result = await service.scrape({
        siteType: [Site.ON2IT],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });

    it('returns an empty response when no registry is injected', async () => {
      const service = new ON2ITService();
      const result = await service.scrape({
        siteType: [Site.ON2IT],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that distinguishes a wiring fault from an empty board.
      expect(result.diagnostics?.reason).toBe('not_registered');
      expect(result.diagnostics?.detail).toContain('Recruitee');
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against the fixture page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_ENVELOPE_RAW) });
      const service = new ON2ITService(registryWithRecruitee());
      const result = await service.scrape({
        siteType: [Site.ON2IT],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });
});
