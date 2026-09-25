import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock the HTTP factory so the scraper hits a controlled fixture
// pipeline instead of a real Avature tenant.
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

import { AvatureModule, AvatureService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const PAGE_1_HTML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'avature-page-1.html'),
  'utf8',
);
const PAGE_EMPTY_HTML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'avature-page-empty.html'),
  'utf8',
);

describe('AvatureService — Spec 006 / T03 + T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
  });

  describe('registration scaffolding (carries forward from T02)', () => {
    it('resolves through AvatureModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AvatureModule],
      }).compile();
      const service = moduleRef.get(AvatureService);
      expect(service).toBeInstanceOf(AvatureService);
      await moduleRef.close();
    });

    it('exports the Site.AVATURE = "avature" enum value', () => {
      expect(Site.AVATURE).toBe('avature');
    });
  });

  describe('happy path — single populated page', () => {
    it('parses 12 jobs minus the Apply-decoy = 11 JobPostDto rows', async () => {
      mockGet
        .mockResolvedValueOnce({ data: PAGE_1_HTML })
        .mockResolvedValueOnce({ data: PAGE_EMPTY_HTML });

      const service = new AvatureService();
      const input: ScraperInputDto = {
        siteType: [Site.AVATURE],
        companySlug: 'bloomberg',
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);

      expect(result).toBeInstanceOf(JobResponseDto);
      // 12 anchors in the fixture, one is an Apply-decoy → 11 rows.
      expect(result.jobs).toHaveLength(11);

      const first = result.jobs[0];
      expect(first.title).toBe('Senior Software Engineer');
      expect(first.id).toBe('avature-12345');
      expect(first.atsType).toBe('avature');
      expect(first.site).toBe(Site.AVATURE);
      expect(first.companyName).toBe('Bloomberg');
      expect(first.jobUrl).toBe(
        'https://bloomberg.avature.net/careers/JobDetail/Senior-Software-Engineer/12345',
      );
      expect(first.location?.city).toBe('New York');
      expect(first.department).toBe('Engineering');
      expect(first.isRemote).toBe(false);

      // Remote-detection sanity check on the SRE row.
      const remoteJob = result.jobs.find((j) => j.id === 'avature-12347');
      expect(remoteJob?.isRemote).toBe(true);

      // No Apply-decoy slipped through.
      expect(result.jobs.find((j) => j.id === 'avature-12349')).toBeUndefined();
    });
  });

  describe('empty board', () => {
    it('first page empty → returns empty JobResponseDto', async () => {
      mockGet.mockResolvedValueOnce({ data: PAGE_EMPTY_HTML });

      const service = new AvatureService();
      const input: ScraperInputDto = {
        siteType: [Site.AVATURE],
        companySlug: 'noresults',
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toEqual([]);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP failure', () => {
    it('catches a 500 and returns an empty JobResponseDto (never throws)', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AvatureService();
      const input: ScraperInputDto = {
        siteType: [Site.AVATURE],
        companySlug: 'broken',
      } as ScraperInputDto;

      await expect(service.scrape(input)).resolves.toBeInstanceOf(
        JobResponseDto,
      );
      const result = await service.scrape(input);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('resultsWanted cap mid-page', () => {
    it('honours resultsWanted=5 against the 12-row fixture page', async () => {
      mockGet.mockResolvedValueOnce({ data: PAGE_1_HTML });

      const service = new AvatureService();
      const input: ScraperInputDto = {
        siteType: [Site.AVATURE],
        companySlug: 'bloomberg',
        resultsWanted: 5,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(5);
      // The cap fires before the second pagination request would.
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom-domain override via companyUrl', () => {
    it('uses companyUrl verbatim and resolves company name from the host', async () => {
      mockGet.mockResolvedValueOnce({ data: PAGE_EMPTY_HTML });

      const service = new AvatureService();
      const input: ScraperInputDto = {
        siteType: [Site.AVATURE],
        companyUrl: 'https://careers.ibm.com/en_US',
      } as ScraperInputDto;

      await service.scrape(input);

      // Locale prefix preserved in the request URL.
      const calledUrl = mockGet.mock.calls[0]?.[0] as string;
      expect(calledUrl.startsWith('https://careers.ibm.com/en_US/careers/SearchJobs/')).toBe(true);
    });

    it('returns empty JobResponseDto when neither companyUrl nor companySlug is supplied', async () => {
      const service = new AvatureService();
      const result = await service.scrape({} as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });
});
