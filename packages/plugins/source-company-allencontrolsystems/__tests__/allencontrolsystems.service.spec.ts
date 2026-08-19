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
import { AshbyService } from '@ever-jobs/source-ats-ashby';

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

import {
  AllencontrolsystemsModule,
  AllencontrolsystemsService,
} from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'allencontrolsystems-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Registry wired with a real AshbyService registered under Site.ASHBY. */
function registryWithAshby(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(
    { site: Site.ASHBY, name: 'Ashby', category: 'ats', isAts: true },
    new AshbyService(),
  );
  return registry;
}

describe('AllencontrolsystemsService — Ashby delegation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AllencontrolsystemsModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AllencontrolsystemsModule],
      }).compile();
      const service = moduleRef.get(AllencontrolsystemsService);
      expect(service).toBeInstanceOf(AllencontrolsystemsService);
      await moduleRef.close();
    });

    it('exports the Site.ALLENCONTROLSYSTEMS = "allencontrolsystems" enum value', () => {
      expect(Site.ALLENCONTROLSYSTEMS).toBe('allencontrolsystems');
    });
  });

  describe('happy path (delegates to the registered Ashby plugin)', () => {
    it('maps all fixture listings to JobPostDto with the company identity', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AllencontrolsystemsService(registryWithAshby());
      const result = (await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
        resultsWanted: 100,
      } as ScraperInputDto)) as JobResponseDto;

      expect(result.jobs).toHaveLength(3);

      const first = JOBS_PAGE_RAW.jobs[0];
      const job0 = result.jobs.find(
        (j) => j.id === 'allencontrolsystems-' + first.id,
      );
      expect(job0).toBeDefined();
      // company identity is re-stamped over Ashby's defaults
      expect(job0?.site).toBe(Site.ALLENCONTROLSYSTEMS);
      expect(job0?.companyName).toBe('Allen Control Systems');
      expect(job0?.id).toBe('allencontrolsystems-' + first.id);
      expect(job0?.id?.startsWith('ashby-')).toBe(false);
      // Ashby-mapped fields flow through untouched
      expect(job0?.title).toBe(first.title);
      expect(job0?.jobUrl).toBe(first.jobUrl);
      expect(job0?.department).toBe(first.departmentName);
      expect(job0?.description).toContain('counter-drone');

      // it hit the Ashby board for the ACS slug, not Greenhouse
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toContain('api.ashbyhq.com/posting-api/job-board');
      expect(calledUrls[0]).toContain('allen-control-systems');
      expect(calledUrls[0]).not.toContain('greenhouse');
    });

    it('every job carries the ACS site, companyName, and id prefix', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AllencontrolsystemsService(registryWithAshby());
      const result = await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.ALLENCONTROLSYSTEMS);
        expect(job.companyName).toBe('Allen Control Systems');
        expect(job.id?.startsWith('allencontrolsystems-')).toBe(true);
      }
    });

    it('preserves Ashby isRemote and location mapping', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AllencontrolsystemsService(registryWithAshby());
      const result = await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
      } as ScraperInputDto);
      const remote = result.jobs.find((j) => j.title === 'Buyer');
      expect(remote?.isRemote).toBe(true);
      const onsite = result.jobs.find((j) => j.title === 'Advanced Drone Operator');
      expect(onsite?.location?.city).toBe('Austin');
    });
  });

  describe('input pass-through', () => {
    it('forwards the company slug and caller input to the Ashby scraper', async () => {
      const captured: ScraperInputDto[] = [];
      const fakeAshby: IScraper = {
        scrape: async (input) => {
          captured.push(input);
          return new JobResponseDto([
            new JobPostDto({ id: 'ashby-x1', title: 'Role', jobUrl: 'u' }),
          ]);
        },
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.ASHBY, name: 'Ashby', category: 'ats', isAts: true },
        fakeAshby,
      );

      const service = new AllencontrolsystemsService(registry);
      const result = await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
        resultsWanted: 7,
      } as ScraperInputDto);

      expect(captured).toHaveLength(1);
      expect(captured[0].companySlug).toBe('allen-control-systems');
      expect(captured[0].resultsWanted).toBe(7);
      expect(result.jobs[0].id).toBe('allencontrolsystems-x1');
      expect(result.jobs[0].site).toBe(Site.ALLENCONTROLSYSTEMS);
    });

    it('only rewrites a leading ashby- id prefix', async () => {
      const fakeAshby: IScraper = {
        scrape: async () =>
          new JobResponseDto([
            new JobPostDto({ id: 'ashby-ashby-7', title: 'T', jobUrl: 'u' }),
          ]),
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.ASHBY, name: 'Ashby', category: 'ats', isAts: true },
        fakeAshby,
      );
      const service = new AllencontrolsystemsService(registry);
      const result = await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
      } as ScraperInputDto);
      expect(result.jobs[0].id).toBe('allencontrolsystems-ashby-7');
    });
  });

  describe('resilience', () => {
    it('returns an empty response when no Ashby plugin is registered', async () => {
      const service = new AllencontrolsystemsService(new PluginRegistry());
      const result = await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });

    it('returns an empty response when no registry is injected', async () => {
      const service = new AllencontrolsystemsService();
      const result = await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that distinguishes a wiring fault from an empty board.
      expect(result.diagnostics?.reason).toBe('not_registered');
      expect(result.diagnostics?.detail).toContain('Ashby');
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new AllencontrolsystemsService(registryWithAshby());
      const result = await service.scrape({
        siteType: [Site.ALLENCONTROLSYSTEMS],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });
});
