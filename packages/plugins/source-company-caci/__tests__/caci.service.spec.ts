import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { PluginRegistry, SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { WorkdayService } from '@ever-jobs/source-ats-workday';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: mockPost, setHeaders: jest.fn() })),
    // The recorded boards are single pages; never sleep between pages in a unit test.
    randomSleep: jest.fn(async () => undefined),
  };
});

import { CaciModule, CaciService } from '../src';

interface Fixture {
  backend: string;
  boards: Array<{ input: Record<string, string>; atsIdPrefix: string }>;
  responses: Record<string, unknown>;
  expected: Array<{ id: string; title: string }>;
}

const FIXTURE: Fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'caci-boards.json'), 'utf8'),
);
const COMPANY_NAME = 'CACI';
const ID_PREFIX = 'caci-';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Serve the recorded responses by URL (query ignored); anything else is a 404. */
function serve(url: string): Promise<{ data: unknown }> {
  const key = String(url).split('?')[0];
  if (Object.prototype.hasOwnProperty.call(FIXTURE.responses, key)) {
    return Promise.resolve({ data: clone(FIXTURE.responses[key]) });
  }
  return notFound(url);
}

function notFound(url: string): Promise<never> {
  const err: any = new Error(`Request failed with status code 404 (${url})`);
  err.response = { status: 404 };
  return Promise.reject(err);
}

function registryWith(scraper: IScraper = new WorkdayService()): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({ site: Site.WORKDAY, name: 'Workday', category: 'ats', isAts: true }, scraper);
  return registry;
}

function fakeBackend(
  impl: (input: ScraperInputDto) => JobResponseDto,
  captured: ScraperInputDto[] = [],
): IScraper {
  return {
    scrape: async (input) => {
      captured.push(input);
      return impl(input);
    },
  };
}

const boardOf = (input: ScraperInputDto): string | undefined => (input as any).companySlug;
const boardInputOf = (b: Fixture['boards'][number]): string => b.input.companySlug;

describe('CaciService — Workday delegation (Spec 1736)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockImplementation(serve);
    mockPost.mockImplementation(serve);
  });

  describe('registration', () => {
    it('resolves through CaciModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [CaciModule] }).compile();
      expect(moduleRef.get(CaciService)).toBeInstanceOf(CaciService);
      await moduleRef.close();
    });

    it('exports Site.CACI = "caci"', () => {
      expect(Site.CACI).toBe('caci');
    });

    it('declares a tagged company plugin with its domains', () => {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, CaciService);
      expect(meta.site).toBe(Site.CACI);
      expect(meta.category).toBe('company');
      expect(meta.isAts).toBeFalsy();
      expect(meta.companyDomains).toEqual(['caci.com']);
      expect(meta.description).toContain('segment=workday-enterprise');
    });
  });

  describe('recorded board (real Workday adapter, mocked HTTP)', () => {
    it('maps every recorded posting and re-stamps the company identity', async () => {
      const service = new CaciService(registryWith());
      const result = await service.scrape({ siteType: [Site.CACI], resultsWanted: 100 } as ScraperInputDto);
      expect(result.diagnostics).toBeUndefined();
      expect(result.jobs.map((j) => j.id)).toEqual(FIXTURE.expected.map((e) => e.id));
      expect(result.jobs.map((j) => j.title)).toEqual(FIXTURE.expected.map((e) => e.title));
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.CACI);
        expect(job.companyName).toBe(COMPANY_NAME);
        expect(job.id?.startsWith(ID_PREFIX)).toBe(true);
        expect(job.jobUrl).toBeTruthy();
      }
    });

    it('only requests the recorded board URLs', async () => {
      const service = new CaciService(registryWith());
      await service.scrape({ siteType: [Site.CACI] } as ScraperInputDto);
      const urls = [...mockGet.mock.calls, ...mockPost.mock.calls].map((c) => String(c[0]).split('?')[0]);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(Object.keys(FIXTURE.responses)).toContain(url);
      }
    });

    it('honours resultsWanted=1', async () => {
      const service = new CaciService(registryWith());
      const result = await service.scrape({ siteType: [Site.CACI], resultsWanted: 1 } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe(FIXTURE.expected[0].id);
    });

    it('resolves with an empty result when the board is gone (HTTP 404)', async () => {
      mockGet.mockImplementation(notFound);
      mockPost.mockImplementation(notFound);
      const service = new CaciService(registryWith());
      const result = await service.scrape({ siteType: [Site.CACI] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('bad_input');
    });
  });

  describe('delegation contract', () => {
    it('forwards the board and the caller input untouched', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new CaciService(
        registryWith(
          fakeBackend(
            () => new JobResponseDto([new JobPostDto({ id: FIXTURE.boards[0].atsIdPrefix + 'x1', title: 'Role', jobUrl: 'u' })]),
            captured,
          ),
        ),
      );
      const result = await service.scrape({
        siteType: [Site.CACI],
        searchTerm: 'software engineer intern',
        location: 'New York',
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(captured).toHaveLength(1);
      expect(boardOf(captured[0])).toBe(boardInputOf(FIXTURE.boards[0]));
      expect(captured[0].searchTerm).toBe('software engineer intern');
      expect(captured[0].location).toBe('New York');
      expect(captured[0].resultsWanted).toBe(1);
      expect(result.jobs[0].id).toBe(ID_PREFIX + 'x1');
      expect(result.jobs[0].site).toBe(Site.CACI);
      expect(result.jobs[0].companyName).toBe(COMPANY_NAME);
    });

    it('never forwards the caller\'s credentials to the board (Spec 1735 §4.5)', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new CaciService(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      await service.scrape({
        siteType: [Site.CACI],
        auth: { workday: { apiKey: 'caller-key' } },
      } as unknown as ScraperInputDto);
      expect(captured).toHaveLength(FIXTURE.boards.length);
      for (const forwarded of captured) {
        expect(forwarded.auth).toBeUndefined();
      }
    });

    it('passes an absent resultsWanted through as absent', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new CaciService(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      await service.scrape({ siteType: [Site.CACI] } as ScraperInputDto);
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].resultsWanted).toBeUndefined();
    });

    it('rewrites only the leading ATS id prefix', async () => {
      const prefix = FIXTURE.boards[0].atsIdPrefix;
      const service = new CaciService(
        registryWith(
          fakeBackend(() => new JobResponseDto([new JobPostDto({ id: prefix + prefix + '7', title: 'T', jobUrl: 'u' })])),
        ),
      );
      const result = await service.scrape({ siteType: [Site.CACI], resultsWanted: 1 } as ScraperInputDto);
      expect(result.jobs[0].id).toBe(ID_PREFIX + prefix + '7');
    });

    it('makes no request when resultsWanted is 0', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new CaciService(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      const result = await service.scrape({ siteType: [Site.CACI], resultsWanted: 0 } as ScraperInputDto);
      expect(captured).toHaveLength(0);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('resilience', () => {
    it('reports not_registered when no registry is injected', async () => {
      const result = await new CaciService().scrape({ siteType: [Site.CACI] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('not_registered');
      expect(result.diagnostics?.detail).toContain('Workday');
    });

    it('reports not_registered when Workday is missing from the registry', async () => {
      const result = await new CaciService(new PluginRegistry()).scrape({
        siteType: [Site.CACI],
      } as ScraperInputDto);
      expect(result.diagnostics?.reason).toBe('not_registered');
    });

    it('surfaces the backend diagnostic of a failed board', async () => {
      const service = new CaciService(
        registryWith(fakeBackend(() => new JobResponseDto([], new ScrapeDiagnostics('fetch_error', 'HTTP 503')))),
      );
      const result = await service.scrape({ siteType: [Site.CACI] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('passes a benign empty-board reason through only when nothing was found', async () => {
      const service = new CaciService(
        registryWith(fakeBackend(() => new JobResponseDto([], new ScrapeDiagnostics('empty', 'no postings')))),
      );
      const result = await service.scrape({ siteType: [Site.CACI] } as ScraperInputDto);
      expect(result.diagnostics?.reason).toBe('empty');
    });

    it('classifies a thrown backend error instead of rejecting', async () => {
      const service = new CaciService(
        registryWith({
          scrape: async () => {
            throw new Error('socket hang up');
          },
        }),
      );
      const result = await service.scrape({ siteType: [Site.CACI] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.reason).not.toBe('ok');
    });
  });

  describe('company name (Spec 1735 §4.2.1)', () => {
    const TENANT = boardInputOf(FIXTURE.boards[0]).split(':')[0];

    async function nameAfterRestamp(companyName: string | null): Promise<string | null | undefined> {
      const service = new CaciService(
        registryWith(
          fakeBackend(
            () =>
              new JobResponseDto([
                new JobPostDto({ id: FIXTURE.boards[0].atsIdPrefix + 'n1', title: 'Role', jobUrl: 'u', companyName }),
              ]),
          ),
        ),
      );
      const result = await service.scrape({ siteType: [Site.CACI], resultsWanted: 1 } as ScraperInputDto);
      return result.jobs[0]?.companyName;
    }

    it('re-stamps the tenant fallback, an empty name and the display name in legal form', async () => {
      const sources = [
        TENANT,
        TENANT.toUpperCase(),
        '',
        '   ',
        null,
        COMPANY_NAME + ', Inc.',
        'The ' + COMPANY_NAME + ' LLC',
        COMPANY_NAME.toUpperCase(),
      ];
      for (const source of sources) {
        expect(await nameAfterRestamp(source)).toBe(COMPANY_NAME);
      }
    });

    it('keeps a business unit the posting names', async () => {
      expect(await nameAfterRestamp('Example Business Unit LLC')).toBe('Example Business Unit LLC');
      expect(await nameAfterRestamp('  Example Business Unit  ')).toBe('Example Business Unit');
    });

    it('keeps a business unit through the real Workday adapter', async () => {
      const responses = clone(FIXTURE.responses) as Record<string, any>;
      const detailUrl = Object.keys(responses).find((url) => responses[url]?.jobPostingInfo);
      expect(detailUrl).toBeDefined();
      responses[detailUrl!].hiringOrganization = { name: 'Example Business Unit LLC' };
      const serveEdited = (url: string): Promise<{ data: unknown }> => {
        const key = String(url).split('?')[0];
        return Object.prototype.hasOwnProperty.call(responses, key)
          ? Promise.resolve({ data: clone(responses[key]) })
          : notFound(url);
      };
      mockGet.mockImplementation(serveEdited);
      mockPost.mockImplementation(serveEdited);

      const service = new CaciService(registryWith());
      const result = await service.scrape({ siteType: [Site.CACI], resultsWanted: 100 } as ScraperInputDto);

      expect(result.jobs.map((j) => j.id)).toEqual(FIXTURE.expected.map((e) => e.id));
      const names = result.jobs.map((j) => j.companyName);
      expect(names.filter((n) => n === 'Example Business Unit LLC')).toHaveLength(1);
      expect(names.filter((n) => n !== 'Example Business Unit LLC').every((n) => n === COMPANY_NAME)).toBe(true);
    });
  });
});
