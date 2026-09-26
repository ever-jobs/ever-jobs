import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { DescriptionFormat, JobPostDto, LocationDto, ScraperInputDto, Site } from '@ever-jobs/models';

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      post: mockPost,
      get: mockGet,
      setHeaders: jest.fn(),
    })),
    // Skip the inter-page rate-limit sleep so multi-page cases stay fast.
    randomSleep: jest.fn(async () => undefined),
  };
});

import { canonicalKey } from '@ever-jobs/common';
import { WorkdayModule } from '../src/workday.module';
import { WorkdayService } from '../src/workday.service';
import {
  ATS_COUNTRY_OVERLAY_ENV_VAR,
  DEFAULT_WORKDAY_MAX_DETAIL_FETCHES,
  DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS,
  WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR,
  WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR,
  FANOUT_DEADLINE_ENV_VAR,
  LEGACY_FANOUT_DEADLINE_ENV_VAR,
  readAtsCountryOverlay,
} from '../src/workday.constants';

/** A single short page (< WORKDAY_PAGE_SIZE) so scrape() does one request. */
const JOBS_PAGE = {
  total: 4,
  jobPostings: [
    {
      title: 'Software Engineer',
      externalPath: '/job/Austin-TX/Software-Engineer_R-101/12345',
      locationsText: 'Austin, TX',
      postedOn: 'Posted Today',
      subtitles: [{ instances: [{ text: 'Engineering' }] }],
    },
    {
      title: 'Data Engineer',
      externalPath: '/job/Palo-Alto-CA/Data-Engineer_R-202/23456',
      locationsText: 'Palo Alto, CA',
      postedOn: 'Posted Yesterday',
    },
    {
      title: 'Product Manager',
      externalPath: '/job/Remote/Product-Manager_R-303/34567',
      locationsText: 'Remote - US',
      postedOn: 'Posted 3 Days Ago',
    },
    {
      title: 'Staff Engineer',
      externalPath: '/job/Fremont-CA/Staff-Engineer_R-404/45678',
      locationsText: 'Fremont, CA',
      postedOn: 'Posted 30+ Days Ago',
    },
  ],
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isoDateOf(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * Spec 720 / T05 — `WorkdayService` datePosted regression tests.
 *
 * Workday's list endpoint emits relative `postedOn` labels; emitted
 * `JobPostDto.datePosted` must be an ISO calendar date or null — never
 * the raw label.
 */
describe('WorkdayService — Spec 720 / T05', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: {} });
  });

  describe('registration scaffolding', () => {
    it('resolves through WorkdayModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [WorkdayModule],
      }).compile();
      const service = moduleRef.get(WorkdayService);
      expect(service).toBeInstanceOf(WorkdayService);
      await moduleRef.close();
    });
  });

  describe('datePosted mapping', () => {
    it('maps relative postedOn labels to ISO dates (or null), never the raw label', async () => {
      mockPost.mockResolvedValueOnce({ data: clone(JOBS_PAGE) });

      const before = isoDateOf(new Date());
      const service = new WorkdayService();
      const result = await service.scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'tesla:5:Tesla',
        resultsWanted: 100,
      } as ScraperInputDto);
      const after = isoDateOf(new Date());

      expect(result.jobs).toHaveLength(4);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost.mock.calls[0][0]).toBe(
        'https://tesla.wd5.myworkdayjobs.com/wday/cxs/tesla/Tesla/jobs',
      );

      const byId = new Map(result.jobs.map((j) => [j.id, j]));

      // "Posted Today" -> today's ISO date (tolerate a midnight rollover mid-test).
      const today = byId.get('wd-tesla-12345');
      expect(today).toBeDefined();
      expect([before, after]).toContain(today?.datePosted);

      // "Posted Yesterday" / "Posted 3 Days Ago" -> real ISO dates.
      expect(byId.get('wd-tesla-23456')?.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(byId.get('wd-tesla-34567')?.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // "Posted 30+ Days Ago" -> null (lower bound only).
      expect(byId.get('wd-tesla-45678')?.datePosted).toBeNull();

      // Regression: the raw relative label must never leak through.
      for (const job of result.jobs) {
        if (job.datePosted !== null) {
          expect(job.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        expect(String(job.datePosted)).not.toMatch(/posted/i);
      }
    });

    it('keeps the other listing fields intact', async () => {
      mockPost.mockResolvedValueOnce({ data: clone(JOBS_PAGE) });
      const service = new WorkdayService();
      const result = await service.scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'tesla:5:Tesla',
      } as ScraperInputDto);

      const job = result.jobs.find((j) => j.id === 'wd-tesla-12345');
      expect(job?.title).toBe('Software Engineer');
      expect(job?.companyName).toBe('tesla');
      expect(job?.site).toBe(Site.WORKDAY);
      // No detail response here, so this is the list-level URL. It carries the
      // career-site segment, like the detail's `externalUrl` (Spec 1736 T11).
      expect(job?.jobUrl).toBe(
        'https://tesla.wd5.myworkdayjobs.com/Tesla/job/Austin-TX/Software-Engineer_R-101/12345',
      );
      expect(job?.location?.city).toBe('Austin');
      expect(job?.location?.state).toBe('TX');
      expect(job?.department).toBe('Engineering');

      const remote = result.jobs.find((j) => j.id === 'wd-tesla-34567');
      expect(remote?.isRemote).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns an empty JobResponseDto when no companySlug is provided', async () => {
      const service = new WorkdayService();
      const result = await service.scrape({
        siteType: [Site.WORKDAY],
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('catches HTTP errors — empty result, never throws', async () => {
      mockPost.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new WorkdayService();
      const result = await service.scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'tesla:5:Tesla',
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });

    it('returns empty when the payload has no jobPostings', async () => {
      mockPost.mockResolvedValueOnce({ data: { total: 0, jobPostings: [] } });
      const service = new WorkdayService();
      const result = await service.scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'tesla:5:Tesla',
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('detail enrichment — Spec 5004', () => {
    const DETAIL_PAGE = {
      total: 1,
      jobPostings: [
        {
          title: 'Reactor Engineer',
          externalPath: '/job/Rockville-MD/Reactor-Engineer_R101234',
          locationsText: '2 Locations',
          postedOn: 'Posted Today',
        },
      ],
    };

    const DETAIL = {
      hiringOrganization: {
        name: 'X-Energy, LLC',
        url: '',
      },
      jobPostingInfo: {
        title: 'Reactor Engineer',
        jobDescription:
          '<p>Build the future with <strong>X-energy</strong>.</p><p>Email jobs@x-energy.com.</p>',
        location: 'Rockville, MD',
        additionalLocations: ['Oak Ridge, TN', 'Rockville, MD'],
        postedOn: 'Posted Yesterday',
        jobReqId: 'R101234',
        externalUrl:
          'https://xenergy.wd5.myworkdayjobs.com/X-energyUS/job/Rockville-MD/Reactor-Engineer_R101234',
        timeType: 'Full time',
        remoteType: 'Remote Eligible',
        jobFamily: [{ name: 'Engineering' }],
      },
    };

    async function scrapeOne(descriptionFormat?: DescriptionFormat) {
      mockPost.mockResolvedValueOnce({ data: clone(DETAIL_PAGE) });
      mockGet.mockResolvedValueOnce({ data: clone(DETAIL) });
      return new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
        descriptionFormat,
      } as ScraperInputDto);
    }

    it('fetches the CXS detail and maps description, expanded locations, and metadata', async () => {
      const result = await scrapeOne();

      expect(mockGet).toHaveBeenCalledWith(
        'https://xenergy.wd5.myworkdayjobs.com/wday/cxs/xenergy/X-energyUS/job/Rockville-MD/Reactor-Engineer_R101234',
      );
      expect(result.jobs).toHaveLength(1);
      const job = result.jobs[0];
      // The tenant, not the detail-only hiring organisation (Spec 1736 T13).
      expect(job.companyName).toBe('xenergy');
      expect(job.description).toBe('Build the future with X-energy.\nEmail jobs@x-energy.com.');
      expect(job.emails).toEqual(['jobs@x-energy.com']);
      expect(job.location?.city).toBe('Rockville, MD; Oak Ridge, TN');
      expect(job.location?.city).not.toContain('2 Locations');
      expect(job.atsId).toBe('R101234');
      expect(job.employmentType).toBe('Full time');
      expect(job.department).toBe('Engineering');
      expect(job.isRemote).toBe(true);
      expect(job.jobUrl).toBe(DETAIL.jobPostingInfo.externalUrl);
      expect(job.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('honors HTML and Markdown description formats', async () => {
      const html = await scrapeOne(DescriptionFormat.HTML);
      expect(html.jobs[0].description).toBe(DETAIL.jobPostingInfo.jobDescription);

      const markdown = await scrapeOne(DescriptionFormat.MARKDOWN);
      expect(markdown.jobs[0].description).toContain('**X-energy**');
      expect(markdown.jobs[0].description).not.toContain('<strong>');
    });

    it('names the posting by its tenant whatever hiringOrganization says (Spec 1736 T13)', async () => {
      for (const name of ['   ', 'Collins Aerospace', 'X-Energy, LLC']) {
        const detail = clone(DETAIL);
        detail.hiringOrganization.name = name;
        mockPost.mockResolvedValueOnce({ data: clone(DETAIL_PAGE) });
        mockGet.mockResolvedValueOnce({ data: detail });

        const result = await new WorkdayService().scrape({
          siteType: [Site.WORKDAY],
          companySlug: 'xenergy:5:X-energyUS',
        } as ScraperInputDto);

        expect(result.jobs[0].description).not.toBeNull();
        expect(result.jobs[0].companyName).toBe('xenergy');
      }
    });

    it('keeps sibling and summary jobs when one detail request fails', async () => {
      const page = clone(DETAIL_PAGE);
      page.total = 2;
      page.jobPostings.push({
        title: 'Fuel Engineer',
        externalPath: '/job/Oak-Ridge-TN/Fuel-Engineer_R202345',
        locationsText: 'Oak Ridge, TN',
        postedOn: 'Posted Today',
      });
      mockPost.mockResolvedValueOnce({ data: page });
      mockGet
        .mockRejectedValueOnce(new Error('detail unavailable'))
        .mockResolvedValueOnce({ data: clone(DETAIL) });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0].description).toBeNull();
      expect(result.jobs[0].companyName).toBe('xenergy');
      // The bare "N Locations" count is not a real place, so it is dropped.
      expect(result.jobs[0].location).toBeNull();
      // Enriched or not, the same name (Spec 1736 T13).
      expect(result.jobs[1].companyName).toBe('xenergy');
      expect(result.jobs[1].description).toContain('Build the future');
    });

    it('does not request detail when externalPath is missing', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          total: 1,
          jobPostings: [{ title: 'Fallback Role', locationsText: 'Rockville, MD' }],
        },
      });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
      } as ScraperInputDto);

      expect(mockGet).not.toHaveBeenCalled();
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].location?.city).toBe('Rockville');
      expect(result.jobs[0].location?.state).toBe('MD');
      expect(result.jobs[0].companyName).toBe('xenergy');
    });

    /**
     * Spec 1736 T8 / Spec 1735 §4.6 — 55 company plugins bring Workday into every
     * default search, so a board may never have more than one detail request in
     * flight, and each detail request is preceded by a paced sleep.
     */
    function sixRolePage() {
      return {
        total: 6,
        jobPostings: Array.from({ length: 6 }, (_, index) => ({
          title: `Role ${index}`,
          externalPath: `/job/Location/Role-${index}_R${index}`,
          locationsText: 'Rockville, MD',
        })),
      };
    }

    it('never has more than one detail request in flight', async () => {
      mockPost.mockResolvedValueOnce({ data: sixRolePage() });

      let inFlight = 0;
      let maxInFlight = 0;
      const resolvers: Array<() => void> = [];
      mockGet.mockImplementation(() => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) =>
          resolvers.push(() => {
            inFlight--;
            resolve({ data: {} });
          }),
        );
      });

      const scrapePromise = new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
      } as ScraperInputDto);

      // Settle the requests one at a time; each step must reveal exactly one
      // new request, never two.
      for (let step = 1; step <= 6; step++) {
        for (let tick = 0; tick < 10 && resolvers.length === 0; tick++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(mockGet).toHaveBeenCalledTimes(step);
        expect(resolvers).toHaveLength(1);
        resolvers.splice(0).forEach((resolve) => resolve());
      }

      const result = await scrapePromise;
      expect(result.jobs).toHaveLength(6);
      expect(maxInFlight).toBe(1);
      expect(mockGet).toHaveBeenCalledTimes(6);
    });

    it('sleeps 250-500 ms before each detail request, and not for a listing without a path', async () => {
      const page = sixRolePage();
      page.jobPostings.push({ title: 'No Path Role', locationsText: 'Rockville, MD' } as never);
      mockPost.mockResolvedValueOnce({ data: page });
      const { randomSleep } = jest.requireMock('@ever-jobs/common') as {
        randomSleep: jest.Mock;
      };
      randomSleep.mockClear();

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(7);
      expect(mockGet).toHaveBeenCalledTimes(6);
      // One short page, so no inter-page sleep: every call is a detail pause.
      expect(randomSleep.mock.calls).toEqual(Array.from({ length: 6 }, () => [250, 500]));
    });
  });

  /**
   * Spec 1736 T6 — the keyword reaches Workday as `searchText`, so a keyword
   * search is filtered server-side and only matching postings are enriched.
   * List mode (contract C1: term absent, null, empty or whitespace) sends ''.
   */
  describe('keyword — Spec 1736 T6', () => {
    async function searchTextFor(searchTerm: unknown): Promise<unknown> {
      mockPost.mockResolvedValueOnce({ data: { total: 0, jobPostings: [] } });
      await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'tesla:5:Tesla',
        searchTerm,
      } as unknown as ScraperInputDto);
      expect(mockPost).toHaveBeenCalledTimes(1);
      const body = mockPost.mock.calls[0][1] as Record<string, unknown>;
      mockPost.mockReset();
      return body.searchText;
    }

    it('sends the trimmed searchTerm as searchText on every listing page', async () => {
      const page = (offset: number, count: number) => ({
        total: 25,
        jobPostings: Array.from({ length: count }, (_, i) => ({
          title: `Intern ${offset + i}`,
          externalPath: `/job/Austin/Intern_R-${offset + i}`,
        })),
      });
      mockPost
        .mockResolvedValueOnce({ data: page(0, 20) })
        .mockResolvedValueOnce({ data: page(20, 5) });

      await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'tesla:5:Tesla',
        searchTerm: '  software engineer intern  ',
        resultsWanted: 100,
      } as ScraperInputDto);

      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(mockPost.mock.calls.map((c) => c[1])).toEqual([
        { appliedFacets: {}, limit: 20, offset: 0, searchText: 'software engineer intern' },
        { appliedFacets: {}, limit: 20, offset: 20, searchText: 'software engineer intern' },
      ]);
    });

    it('sends an empty search in list mode', async () => {
      expect(await searchTextFor(undefined)).toBe('');
      expect(await searchTextFor(null)).toBe('');
      expect(await searchTextFor('')).toBe('');
      expect(await searchTextFor('   ')).toBe('');
    });
  });

  /**
   * Spec 5013 — field mappings the Workday CXS payload carries but the plugin
   * never surfaced: compensation (text), workFromHomeType, multi-location +
   * country, and startDate-first datePosted.
   */
  describe('field mappings — Spec 5013', () => {
    const PAGE = {
      total: 1,
      jobPostings: [
        {
          title: 'Reactor Engineer',
          externalPath: '/job/Rockville-MD/Reactor-Engineer_R900',
          locationsText: '2 Locations',
          postedOn: 'Posted 30+ Days Ago',
        },
      ],
    };

    function detail(overrides: Record<string, unknown> = {}) {
      return {
        hiringOrganization: { name: 'X-Energy, LLC', url: '' },
        jobPostingInfo: {
          title: 'Reactor Engineer',
          jobDescription:
            '<p>Join us. The base salary range for this role is $120,000 - $150,000 per year.</p>',
          location: 'Rockville, MD',
          additionalLocations: ['Oak Ridge, TN'],
          postedOn: 'Posted 30+ Days Ago',
          startDate: '2026-05-20',
          jobReqId: 'R900',
          timeType: 'Full time',
          remoteType: 'Hybrid',
          jobRequisitionLocation: { country: { alpha2Code: 'US' } },
          ...overrides,
        },
      };
    }

    async function scrapeWith(detailPayload: object) {
      mockPost.mockResolvedValueOnce({ data: clone(PAGE) });
      mockGet.mockResolvedValueOnce({ data: detailPayload });
      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
      } as ScraperInputDto);
      return result.jobs[0];
    }

    it('extracts compensation from the description body text (no structured field)', async () => {
      const job = await scrapeWith(detail());
      expect(job.compensation).toBeDefined();
      expect(job.compensation?.minAmount).toBe(120000);
      expect(job.compensation?.maxAmount).toBe(150000);
      expect(job.compensation?.currency).toBe('USD');
    });

    it('leaves compensation null when the description carries no salary', async () => {
      const job = await scrapeWith(
        detail({ jobDescription: '<p>Join our mission to build clean energy.</p>' }),
      );
      expect(job.compensation == null).toBe(true);
    });

    it('maps remoteType to workFromHomeType (Hybrid)', async () => {
      const job = await scrapeWith(detail());
      expect(job.workFromHomeType).toBe('Hybrid');
    });

    it('maps a remote remoteType to workFromHomeType Remote and isRemote', async () => {
      const job = await scrapeWith(detail({ remoteType: 'Fully Remote' }));
      expect(job.workFromHomeType).toBe('Remote');
      expect(job.isRemote).toBe(true);
    });

    it('leaves workFromHomeType unset for on-site remoteType values', async () => {
      const job = await scrapeWith(
        detail({ remoteType: 'Field/Customer Site', location: 'Rockville, MD', additionalLocations: [] }),
      );
      expect(job.workFromHomeType == null).toBe(true);
    });

    it('splits multiple locations through the shared parser', async () => {
      const job = await scrapeWith(detail());
      expect(job.location?.city).toBe('Rockville, MD; Oak Ridge, TN');
      expect(job.location?.city).not.toContain('2 Locations');
      expect(job.locations).toMatchObject([
        { city: 'Rockville', state: 'MD' },
        { city: 'Oak Ridge', state: 'TN' },
      ]);
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

      it('is ON by default: folds the ISO-2 code into the location via regionNameFromCode', async () => {
        const job = await scrapeWith(
          detail({ location: 'Rockville, MD', additionalLocations: [] }),
        );
        expect(job.location?.country).toBe('United States');
        // The single-site locations[] agrees with location.
        expect(job.locations).toMatchObject([
          { city: 'Rockville', state: 'MD', country: 'United States' },
        ]);
        // countryCode is still emitted, verbatim.
        expect(job.countryCode).toBe('US');
      });

      it('folds a non-US code into a bare city', async () => {
        const job = await scrapeWith(
          detail({
            location: 'Amsterdam',
            additionalLocations: [],
            jobRequisitionLocation: { country: { alpha2Code: 'NL' } },
          }),
        );
        expect(job.location?.city).toBe('Amsterdam');
        expect(job.location?.country).toBe('Netherlands');
        expect(job.countryCode).toBe('NL');
      });

      it('never overwrites a country the parser found', async () => {
        const job = await scrapeWith(
          detail({
            location: 'Berlin, Germany',
            additionalLocations: [],
            jobRequisitionLocation: { country: { alpha2Code: 'NL' } },
          }),
        );
        expect(job.location?.country).toBe('Germany');
        expect(job.countryCode).toBe('NL');
      });

      it('fills the merged location but leaves a multi-site locations[] as parsed', async () => {
        const job = await scrapeWith(detail());
        expect(job.location?.city).toBe('Rockville, MD; Oak Ridge, TN');
        expect(job.location?.country).toBe('United States');
        expect(job.locations).toHaveLength(2);
        for (const site of job.locations ?? []) expect(site.country == null).toBe(true);
      });

      it('ignores an unresolvable code', async () => {
        const job = await scrapeWith(
          detail({
            location: 'Rockville, MD',
            additionalLocations: [],
            jobRequisitionLocation: { country: { alpha2Code: 'QZ' } },
          }),
        );
        expect(job.location?.country == null).toBe(true);
        expect(job.countryCode).toBe('QZ');
      });

      it.each(['false', 'FALSE', '0', 'no', 'off'])(
        'is OFF when %s: the code goes to countryCode only (Spec 5118)',
        async (value) => {
          process.env[ENV] = value;
          const job = await scrapeWith(
            detail({ location: 'Rockville, MD', additionalLocations: [] }),
          );
          expect(job.countryCode).toBe('US');
          expect(job.location?.country == null).toBe(true);
          expect(job.locations?.[0]?.country == null).toBe(true);
        },
      );

      it('readAtsCountryOverlay parses the env var', () => {
        expect(readAtsCountryOverlay({})).toBe(true);
        expect(readAtsCountryOverlay({ [ENV]: 'true' })).toBe(true);
        expect(readAtsCountryOverlay({ [ENV]: 'maybe' })).toBe(true);
        expect(readAtsCountryOverlay({ [ENV]: ' Off ' })).toBe(false);
      });
    });

    it('leaves countryCode unset when no alpha2Code is present', async () => {
      const job = await scrapeWith(
        detail({ location: 'Rockville, MD', additionalLocations: [], jobRequisitionLocation: null }),
      );
      expect(job.countryCode == null).toBe(true);
      // Spec 1736 T13: a single site in a US state implies the country the
      // overlay would fold in for a US requisition, so this posting keys like
      // its list-level copy (which never has a requisition country).
      expect(job.location?.country).toBe('United States');
      expect(job.locations?.[0]?.country).toBe('United States');
    });

    it('implies no country for a site outside the 50 states and DC', async () => {
      for (const location of ['Warsaw', 'San Juan, PR']) {
        const job = await scrapeWith(detail({ location, additionalLocations: [], jobRequisitionLocation: null }));
        expect([location, job.location?.country == null]).toEqual([location, true]);
      }
    });

    it('prefers the absolute startDate over the lossy relative postedOn label', async () => {
      const job = await scrapeWith(detail());
      // "Posted 30+ Days Ago" alone yields null; startDate recovers the date.
      expect(job.datePosted).toBe('2026-05-20');
    });

    it('falls back to the relative label when startDate is missing', async () => {
      const job = await scrapeWith(detail({ startDate: null, postedOn: 'Posted Today' }));
      expect(job.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  /**
   * Spec 5025 — remote under-detection: Workday occasionally emits a slugified
   * location label (e.g. "Remote_USA"). The underscore is a word character, so
   * the shared parser's `\bremote\b` check missed it and `isRemote` stayed
   * false. Normalizing underscores to spaces restores detection.
   */
  /**
   * Spec 5084 — some tenants answer an out-of-range offset by re-serving page 1
   * instead of an empty page. Pagination must terminate on client-side evidence
   * (distinct postings) rather than on the server shortening a page.
   */
  describe('pagination termination — Spec 5084', () => {
    /** N distinct postings, page-shaped. */
    function page(count: number, startIndex = 0, total?: number | null) {
      return {
        ...(total === undefined ? {} : { total }),
        jobPostings: Array.from({ length: count }, (_, i) => ({
          title: `Engineer ${startIndex + i}`,
          externalPath: `/job/Anywhere/Engineer_R-${startIndex + i}`,
          locationsText: 'Austin, TX',
          postedOn: 'Posted Today',
        })),
      };
    }

    it('stops on a positive total instead of requesting past the end', async () => {
      mockPost.mockResolvedValue({ data: page(20, 0, 20) });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'acme:108:Acme_Careers',
        resultsWanted: 9999,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(20);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledTimes(20);
    });

    it('stops when a page adds no new postings, even with no usable total', async () => {
      // Every offset re-serves page 1, and total is absent — the no-progress guard
      // is the only thing that can end this.
      mockPost.mockResolvedValue({ data: page(20, 0, undefined) });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'acme:108:Acme_Careers',
        resultsWanted: 9999,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(20);
      expect(mockPost).toHaveBeenCalledTimes(2);
      // One request per distinct posting, not per accumulated entry.
      expect(mockGet).toHaveBeenCalledTimes(20);
    });

    it('does not truncate an honest multi-page board', async () => {
      mockPost
        .mockResolvedValueOnce({ data: page(20, 0, 24) })
        .mockResolvedValueOnce({ data: page(4, 20, 24) });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'acme:503:Acme_Careers',
        resultsWanted: 9999,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(24);
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('keeps paging when a real page reports total 0', async () => {
      mockPost
        .mockResolvedValueOnce({ data: page(20, 0, 0) })
        .mockResolvedValueOnce({ data: page(5, 20, 0) });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'acme:108:Acme_Careers',
        resultsWanted: 9999,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(25);
    });

    it('bounds resultsWanted by distinct postings', async () => {
      mockPost.mockResolvedValue({ data: page(20, 0, undefined) });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'acme:108:Acme_Careers',
        resultsWanted: 5,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(5);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('does not enrich after a pagination failure', async () => {
      mockPost
        .mockResolvedValueOnce({ data: page(20, 0, 100) })
        .mockRejectedValueOnce(new Error('Request failed with status code 429'));

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'acme:108:Acme_Careers',
        resultsWanted: 9999,
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBeDefined();
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  /**
   * Spec 1736 T11 (review finding F8) — one board must not cost minutes. Detail
   * enrichment is sequential and paced, so it is capped per scrape
   * (WORKDAY_MAX_DETAIL_FETCHES, default 50) and bounded in time together with
   * the listing (WORKDAY_SCRAPE_TIME_BUDGET_MS, default 90 s). Postings past
   * either limit are still returned, at list level.
   */
  describe('detail cap and time budget — Spec 1736 T11', () => {
    const T0 = 1_750_000_000_000;
    let clock = T0;

    /** `count` distinct postings with detail paths, requisition id in bulletFields. */
    function rolesPage(count: number, startIndex = 0, total: number = count) {
      return {
        total,
        jobPostings: Array.from({ length: count }, (_, i) => ({
          title: `Role ${startIndex + i}`,
          externalPath: `/job/Rockville-MD/Role-${startIndex + i}_JR${1000 + startIndex + i}`,
          locationsText: 'Rockville, MD',
          postedOn: 'Posted Today',
          bulletFields: ['Spotlight Job', `JR${1000 + startIndex + i}`],
        })),
      };
    }

    /** A detail response for the posting at `path`, with the matching jobReqId. */
    function detailFor(path: string) {
      const reqId = path.split('_').pop() as string;
      return {
        data: {
          hiringOrganization: { name: 'Acme Corp' },
          jobPostingInfo: {
            jobDescription: `<p>About ${reqId}.</p>`,
            jobReqId: reqId,
            externalUrl: `https://acme.wd5.myworkdayjobs.com/Careers${path}`,
          },
        },
      };
    }

    function servePathDetails(advanceMs = 0) {
      mockGet.mockImplementation(async (url: string) => {
        clock += advanceMs;
        return detailFor(url.slice(url.indexOf('/job/')));
      });
    }

    function scrape(extra: Partial<ScraperInputDto> = {}) {
      return new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'acme:5:Careers',
        ...extra,
      } as ScraperInputDto);
    }

    // The budget is capped by the fan-out deadline hint (T15): every case starts
    // from the API default (neither variable set) and the caller's env is restored.
    const DEADLINE_VARS = [FANOUT_DEADLINE_ENV_VAR, LEGACY_FANOUT_DEADLINE_ENV_VAR] as const;
    const savedDeadlineEnv = new Map<string, string | undefined>();

    beforeEach(() => {
      clock = T0;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      delete process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR];
      for (const name of DEADLINE_VARS) {
        savedDeadlineEnv.set(name, process.env[name]);
        delete process.env[name];
      }
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      delete process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR];
      for (const name of DEADLINE_VARS) {
        const saved = savedDeadlineEnv.get(name);
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    });

    it('enriches at most 50 postings by default and returns the rest at list level', async () => {
      mockPost
        .mockResolvedValueOnce({ data: rolesPage(20, 0, 55) })
        .mockResolvedValueOnce({ data: rolesPage(20, 20, 55) })
        .mockResolvedValueOnce({ data: rolesPage(15, 40, 55) });
      servePathDetails();

      const result = await scrape({ resultsWanted: 100 });

      expect(DEFAULT_WORKDAY_MAX_DETAIL_FETCHES).toBe(50);
      expect(result.jobs).toHaveLength(55);
      expect(mockGet).toHaveBeenCalledTimes(50);
      // The first 50 in list order are the enriched ones.
      expect(result.jobs.slice(0, 50).every((job) => job.description?.startsWith('About JR'))).toBe(true);
      expect(result.jobs.slice(50).map((job) => job.description)).toEqual([null, null, null, null, null]);
      // The cap is by design, not a failure: no diagnostic.
      expect(result.diagnostics).toBeUndefined();
    });

    it('honours WORKDAY_MAX_DETAIL_FETCHES and maps list-level postings fully', async () => {
      process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = '2';
      mockPost.mockResolvedValueOnce({ data: rolesPage(4) });
      servePathDetails();

      const result = await scrape();

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(4);
      const [enriched, , listLevel] = result.jobs;
      expect(enriched.description).toBe('About JR1000.');
      // The detail says "Acme Corp"; both levels carry the tenant (Spec 1736 T13).
      expect(enriched.companyName).toBe('acme');
      expect(enriched.jobUrl).toBe('https://acme.wd5.myworkdayjobs.com/Careers/job/Rockville-MD/Role-0_JR1000');
      expect(listLevel.description).toBeNull();
      expect(listLevel.compensation).toBeNull();
      expect(listLevel.companyName).toBe('acme');
      expect(listLevel.title).toBe('Role 2');
      expect(listLevel.id).toBe('wd-acme-JR1002');
      expect(listLevel.atsId).toBe('JR1002');
      // The same URL shape as an enriched posting's externalUrl.
      expect(listLevel.jobUrl).toBe('https://acme.wd5.myworkdayjobs.com/Careers/job/Rockville-MD/Role-2_JR1002');
      expect(listLevel.location?.city).toBe('Rockville');
      expect(listLevel.location?.state).toBe('MD');
      expect(listLevel.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('gives a posting the same id whether or not it was enriched', async () => {
      mockPost.mockResolvedValueOnce({ data: rolesPage(3) });
      servePathDetails();
      const enriched = await scrape();

      process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = '0';
      mockPost.mockResolvedValueOnce({ data: rolesPage(3) });
      const listLevel = await scrape();

      expect(enriched.jobs.map((job) => job.description)).not.toContain(null);
      expect(listLevel.jobs.map((job) => job.description)).toEqual([null, null, null]);
      expect(listLevel.jobs.map((job) => job.id)).toEqual(enriched.jobs.map((job) => job.id));
      expect(listLevel.jobs.map((job) => job.id)).toEqual(['wd-acme-JR1000', 'wd-acme-JR1001', 'wd-acme-JR1002']);
    });

    it('makes no detail request and no detail pause with WORKDAY_MAX_DETAIL_FETCHES=0', async () => {
      process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = '0';
      mockPost.mockResolvedValueOnce({ data: rolesPage(5) });
      const { randomSleep } = jest.requireMock('@ever-jobs/common') as { randomSleep: jest.Mock };
      randomSleep.mockClear();

      const result = await scrape();

      expect(result.jobs).toHaveLength(5);
      expect(mockGet).not.toHaveBeenCalled();
      expect(randomSleep).not.toHaveBeenCalled();
    });

    it('does not spend the cap on listings without a detail path', async () => {
      process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = '2';
      const page = rolesPage(3);
      page.jobPostings.splice(0, 0, { title: 'No Path A', locationsText: 'Rockville, MD' } as never);
      page.jobPostings.splice(2, 0, { title: 'No Path B', locationsText: 'Rockville, MD' } as never);
      page.total = page.jobPostings.length;
      mockPost.mockResolvedValueOnce({ data: page });
      servePathDetails();

      const result = await scrape();

      expect(result.jobs.map((job) => job.title)).toEqual(['No Path A', 'Role 0', 'No Path B', 'Role 1', 'Role 2']);
      expect(mockGet.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual([
        'Role-0_JR1000',
        'Role-1_JR1001',
      ]);
      expect(result.jobs.map((job) => job.description !== null)).toEqual([false, true, false, true, false]);
    });

    it('stops enriching once the time budget is spent, keeping every posting', async () => {
      process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR] = '2500';
      mockPost.mockResolvedValueOnce({ data: rolesPage(6) });
      // Each detail request takes 1 s: requests start at +0, +1 s and +2 s; the
      // fourth would start at +3 s, past the 2.5 s budget.
      servePathDetails(1000);

      const result = await scrape();

      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(result.jobs).toHaveLength(6);
      expect(result.jobs.map((job) => job.description !== null)).toEqual([true, true, true, false, false, false]);
      // Every posting is returned: no diagnostic.
      expect(result.diagnostics).toBeUndefined();
    });

    it('stops paging once the time budget is spent and reports a partial result', async () => {
      process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR] = '1500';
      let served = 0;
      mockPost.mockImplementation(async () => {
        clock += 1000;
        return { data: rolesPage(20, 20 * served++, 100) };
      });
      servePathDetails();

      const result = await scrape({ resultsWanted: 100 });

      // Page 1 ends at +1 s (within budget), page 2 at +2 s (spent): no page 3.
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(40);
      // Nothing is enriched after the budget is gone.
      expect(mockGet).not.toHaveBeenCalled();
      expect(result.jobs.every((job) => job.description === null)).toBe(true);
      expect(result.diagnostics?.reason).toBe('partial');
      expect(result.diagnostics?.detail).toContain(`${WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR}=1500`);
      expect(result.diagnostics?.detail).toContain('40 of 100 wanted postings');
      expect(result.diagnostics?.detail).toContain('board total 100');
    });

    it('always requests the first listing page, however small the budget', async () => {
      process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR] = '1';
      mockPost.mockImplementation(async () => {
        clock += 1000;
        return { data: rolesPage(3) };
      });

      const result = await scrape();

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(result.jobs).toHaveLength(3);
      expect(mockGet).not.toHaveBeenCalled();
      // The board was listed completely (one short page): not partial.
      expect(result.diagnostics).toBeUndefined();
    });

    it('applies no time budget with WORKDAY_SCRAPE_TIME_BUDGET_MS=0', async () => {
      process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR] = '0';
      let served = 0;
      mockPost.mockImplementation(async () => {
        clock += 10 * 60_000;
        return { data: rolesPage(20, 20 * served++, 40) };
      });
      servePathDetails(10 * 60_000);

      const result = await scrape({ resultsWanted: 40 });

      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(40);
      // Still bounded by the count cap (50), which 40 postings do not reach.
      expect(mockGet).toHaveBeenCalledTimes(40);
      expect(result.diagnostics).toBeUndefined();
    });

    it('defaults the time budget to 90 s', async () => {
      expect(DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS).toBe(90_000);
      mockPost.mockResolvedValueOnce({ data: rolesPage(4) });
      // 30 s per detail request: +0, +30 s and +60 s start; +90 s does not.
      servePathDetails(30_000);

      const result = await scrape();

      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(result.jobs).toHaveLength(4);
    });

    it('caps the budget at 3/4 of the fan-out deadline hint (T15), from either name', async () => {
      for (const name of DEADLINE_VARS) {
        mockGet.mockReset();
        process.env[name] = '40000';
        mockPost.mockResolvedValueOnce({ data: rolesPage(6) });
        // 10 s per detail request: +0, +10 s and +20 s start; +30 s (the capped
        // 30 s budget) does not, where the uncapped 90 s would allow all six.
        servePathDetails(10_000);
        clock = T0;

        const result = await scrape();

        expect([name, mockGet.mock.calls.length]).toEqual([name, 3]);
        expect(result.jobs).toHaveLength(6);
        delete process.env[name];
      }
    });

    it('names the cap in a listing cut short by it', async () => {
      process.env[FANOUT_DEADLINE_ENV_VAR] = '2000';
      let served = 0;
      mockPost.mockImplementation(async () => {
        clock += 1000;
        return { data: rolesPage(20, 20 * served++, 100) };
      });
      servePathDetails();

      const result = await scrape({ resultsWanted: 100 });

      // Budget 1.5 s (3/4 of 2 s): page 1 ends at +1 s, page 2 at +2 s (spent).
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(result.diagnostics?.reason).toBe('partial');
      expect(result.diagnostics?.detail).toContain(
        `${WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR}=90000 capped to 1500 by the fan-out deadline 2000`,
      );
    });

    it('does not pause before a listing page that will never be requested', async () => {
      process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = '0';
      mockPost.mockResolvedValueOnce({ data: rolesPage(20, 0, 100) });
      const { randomSleep } = jest.requireMock('@ever-jobs/common') as { randomSleep: jest.Mock };
      randomSleep.mockClear();

      const result = await scrape({ resultsWanted: 20 });

      expect(result.jobs).toHaveLength(20);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(randomSleep).not.toHaveBeenCalled();
    });
  });

  /**
   * Recorded from Moderna's public board (`modernatx:1:M_tx`) on 2026-09-25:
   * the first page of the search and the detail of its first posting,
   * verbatim except the description body, which is a stand-in.
   */
  describe('recorded Moderna posting — Spec 1736 T12, T13', () => {
    const FIXTURES = path.join(__dirname, 'fixtures');
    const MODERNA_LIST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'moderna-list.json'), 'utf8'));
    const MODERNA_DETAIL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'moderna-detail.json'), 'utf8'));

    /** The recorded page cut to its first posting, the one the detail belongs to. */
    function firstPostingPage() {
      return { ...clone(MODERNA_LIST), total: 1, jobPostings: clone(MODERNA_LIST.jobPostings.slice(0, 1)) };
    }

    async function scrapeEnriched(detail: unknown = MODERNA_DETAIL) {
      mockPost.mockResolvedValueOnce({ data: firstPostingPage() });
      mockGet.mockResolvedValueOnce({ data: clone(detail) });
      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'modernatx:1:M_tx',
      } as ScraperInputDto);
      expect(mockGet).toHaveBeenCalledWith(
        'https://modernatx.wd1.myworkdayjobs.com/wday/cxs/modernatx/M_tx/job/Norwood-Massachusetts/Sr-Specialist--Maintenance_R19827',
      );
      expect(result.jobs).toHaveLength(1);
      return result.jobs[0];
    }

    it('records a department under additionalLocations', () => {
      expect(MODERNA_DETAIL.jobPostingInfo.location).toBe('Norwood, Massachusetts');
      expect(MODERNA_DETAIL.jobPostingInfo.additionalLocations).toEqual(['Drug Manufacturing']);
      expect(MODERNA_DETAIL.jobPostingInfo.jobFamily).toBeUndefined();
    });

    it('keeps the department out of the location and uses it as the department', async () => {
      const job = await scrapeEnriched();

      expect(job.description).not.toBeNull();
      expect(job.location).toMatchObject({ city: 'Norwood', state: 'MA', country: 'United States' });
      expect(job.locations).toHaveLength(1);
      expect(JSON.stringify([job.location, job.locations])).not.toContain('Drug Manufacturing');
      expect(job.department).toBe('Drug Manufacturing');
    });

    it('keeps an additional site next to the rejected entry', async () => {
      const detail = clone(MODERNA_DETAIL);
      detail.jobPostingInfo.additionalLocations = ['Drug Manufacturing', 'Cambridge, Massachusetts'];

      const job = await scrapeEnriched(detail);

      expect(job.locations?.map((l) => `${l.city}, ${l.state}`)).toEqual(['Norwood, MA', 'Cambridge, MA']);
      expect(job.department).toBe('Drug Manufacturing');
    });

    it("never overrides the posting's own job family", async () => {
      const detail = clone(MODERNA_DETAIL);
      detail.jobPostingInfo.jobFamily = [{ name: 'Manufacturing Engineering' }];

      const job = await scrapeEnriched(detail);

      expect(job.department).toBe('Manufacturing Engineering');
      expect(job.locations).toHaveLength(1);
    });

    /**
     * Spec 1736 T13 / §8.1: the same posting, enriched in one search and past
     * the detail cap in the next, must give the dedup key the same title,
     * company and location, and keep its id.
     */
    describe('one identity, enriched or list level (T13)', () => {
      // The day the fixtures were recorded: "Posted Today" and startDate agree.
      const RECORDED_AT = new Date('2026-09-25T15:00:00Z');

      beforeEach(() => {
        // Fake the clock only: pagination and enrichment still run on real ticks.
        jest.useFakeTimers({
          now: RECORDED_AT,
          doNotFake: [
            'hrtime',
            'nextTick',
            'performance',
            'queueMicrotask',
            'setImmediate',
            'clearImmediate',
            'setInterval',
            'clearInterval',
            'setTimeout',
            'clearTimeout',
          ],
        });
        delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      });

      afterEach(() => {
        jest.useRealTimers();
        delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      });

      async function scrapeListLevel(page: unknown = firstPostingPage()) {
        process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = '0';
        mockPost.mockResolvedValueOnce({ data: page });
        const result = await new WorkdayService().scrape({
          siteType: [Site.WORKDAY],
          companySlug: 'modernatx:1:M_tx',
        } as ScraperInputDto);
        delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
        return result;
      }

      /** The key the dedup engine builds (dedup-hybrid: title, company, location, locations, isRemote). */
      function dedupKeyOf(job: JobPostDto): string {
        return canonicalKey({
          title: job.title,
          company: job.companyName,
          location: job.location ? new LocationDto(job.location).displayLocation() : '',
          locations: job.locations,
          isRemote: job.isRemote,
        });
      }

      it('gives the recorded posting the same dedup fields and id at both levels', async () => {
        const enriched = await scrapeEnriched();
        const listLevel = (await scrapeListLevel()).jobs[0];

        expect(enriched.description).not.toBeNull();
        expect(listLevel.description).toBeNull();
        expect(mockGet).toHaveBeenCalledTimes(1);

        expect(listLevel.id).toBe('wd-modernatx-R19827');
        expect(listLevel.id).toBe(enriched.id);
        expect(listLevel.atsId).toBe(enriched.atsId);
        expect(listLevel.title).toBe(enriched.title);
        expect(listLevel.companyName).toBe('modernatx');
        expect(listLevel.companyName).toBe(enriched.companyName);
        expect(listLevel.location).toEqual(enriched.location);
        expect(listLevel.location).toMatchObject({ city: 'Norwood', state: 'MA', country: 'United States' });
        expect(listLevel.locations).toEqual(enriched.locations);
        expect(listLevel.isRemote).toBe(enriched.isRemote);
        expect(dedupKeyOf(listLevel)).toBe(dedupKeyOf(enriched));
        expect(dedupKeyOf(listLevel)).toBe('modernatx|senior specialist maintenance|norwood massachusetts united states');
        // Absolute at both levels: the detail's startDate, the row's "Posted Today" on the recording day.
        expect(enriched.datePosted).toBe('2026-09-25');
        expect(listLevel.datePosted).toBe(enriched.datePosted);
        // Only the requisition country is ATS-declared.
        expect(enriched.countryCode).toBe('US');
        expect(listLevel.countryCode).toBeNull();
      });

      it('takes every recorded row its place from the location bullet, never the department', async () => {
        const result = await scrapeListLevel(clone(MODERNA_LIST));

        expect(result.jobs).toHaveLength(MODERNA_LIST.jobPostings.length);
        for (const [index, job] of result.jobs.entries()) {
          const row = MODERNA_LIST.jobPostings[index];
          expect(row.locationsText).toBeUndefined();
          expect(job.id).toBe(`wd-modernatx-${row.bulletFields[2]}`);
          expect(job.location?.text).toBe(row.bulletFields[0]);
          expect(job.location?.country).toBe('United States');
          expect(JSON.stringify(job.location)).not.toContain(row.bulletFields[1]);
        }
        expect(result.jobs.map((job) => job.location?.city)).toEqual([
          'Norwood',
          'Norwood',
          'Norwood',
          'Norwood',
          'Cambridge',
        ]);
      });

      it('leaves the country out when the overlay is off, at both levels', async () => {
        process.env[ATS_COUNTRY_OVERLAY_ENV_VAR] = 'false';
        try {
          const enriched = await scrapeEnriched();
          const listLevel = (await scrapeListLevel()).jobs[0];
          expect(enriched.location?.country).toBeUndefined();
          expect(listLevel.location).toEqual(enriched.location);
          expect(dedupKeyOf(listLevel)).toBe(dedupKeyOf(enriched));
        } finally {
          delete process.env[ATS_COUNTRY_OVERLAY_ENV_VAR];
        }
      });
    });
  });

  /**
   * Spec 1736 T17 (§8.1, "Date"): Workday counts "Posted Today / Yesterday /
   * N Days Ago" on the board's own calendar, not UTC's. Moderna's board is on
   * US Eastern time, so from 00:00 UTC until midnight in Massachusetts every
   * list-level posting came out one day later than its detail's `startDate`
   * (20 of 20 in the 2026-09-26 00:42 UTC retest).
   */
  describe("list-level datePosted on the board's own calendar — Spec 1736 T17", () => {
    const FIXTURES = path.join(__dirname, 'fixtures');
    /** First listing page and every row's detail dates, recorded 2026-09-26 01:33 UTC (21:33 on the 25th in Massachusetts). */
    const LIST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'moderna-list-after-utc-midnight.json'), 'utf8'));
    const DATES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'moderna-detail-dates-after-utc-midnight.json'), 'utf8')) as {
      recordedAt: string;
      details: Array<{ externalPath: string; jobReqId: string; postedOn: string; startDate: string }>;
    };
    const RECORDED_AT = new Date(DATES.recordedAt);
    const START_DATE = new Map(DATES.details.map((d) => [`wd-modernatx-${d.jobReqId}`, d.startDate]));

    /** Serve a detail for each listed row: its `jobReqId`, `postedOn` and `startDate`. */
    function serveDetails(
      details: ReadonlyArray<{ externalPath: string; jobReqId: string; postedOn?: string | null; startDate?: string | null }>,
    ) {
      mockGet.mockImplementation(async (url: string) => {
        const detail = details.find((d) => url.endsWith(d.externalPath));
        if (!detail) throw new Error(`no recorded detail for ${url}`);
        return {
          data: {
            jobPostingInfo: {
              jobDescription: `<p>About ${detail.jobReqId}.</p>`,
              jobReqId: detail.jobReqId,
              postedOn: detail.postedOn,
              startDate: detail.startDate,
            },
          },
        };
      });
    }

    function useClock(now: Date) {
      // Fake the clock only: pagination and enrichment still run on real ticks.
      jest.useFakeTimers({
        now,
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
    }

    async function scrapeAt(now: Date, maxDetails: number, page: unknown = clone(LIST), slug = 'modernatx:1:M_tx') {
      useClock(now);
      process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR] = String(maxDetails);
      mockPost.mockResolvedValueOnce({ data: page });
      return new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: slug,
        // One page: the recorded page is full (20 of 201), so a larger ask would page on.
        resultsWanted: 20,
      } as ScraperInputDto);
    }

    const savedTimeBudget = process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR];

    beforeEach(() => {
      // Detail pacing is mocked away; no budget so every allowed detail is fetched.
      process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR] = '0';
    });

    afterEach(() => {
      jest.useRealTimers();
      delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      if (savedTimeBudget === undefined) delete process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR];
      else process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR] = savedTimeBudget;
    });

    it('records a board one calendar day behind UTC', () => {
      expect(RECORDED_AT.toISOString()).toBe('2026-09-26T01:33:19.585Z');
      expect(LIST.jobPostings).toHaveLength(20);
      expect(DATES.details).toHaveLength(20);
      // Each row's label counts back from 2026-09-25, the date in Massachusetts.
      for (const [index, row] of LIST.jobPostings.entries()) {
        const detail = DATES.details[index];
        expect(detail.externalPath).toBe(row.externalPath);
        expect(detail.postedOn).toBe(row.postedOn);
        const daysAgo = { 'Posted Today': 0, 'Posted Yesterday': 1, 'Posted 2 Days Ago': 2, 'Posted 3 Days Ago': 3 }[
          row.postedOn as string
        ];
        const implied = new Date(Date.parse(`${detail.startDate}T00:00:00Z`) + (daysAgo as number) * 86_400_000);
        expect(implied.toISOString().slice(0, 10)).toBe('2026-09-25');
      }
    });

    // The host time zone plays no part (Date's UTC fields only): the constants suite
    // runs the date helpers in six real host time zones in a child process.
    it('gives every list-level row the date its detail gives, at the recorded moment', async () => {
      serveDetails(DATES.details);
      const result = await scrapeAt(RECORDED_AT, 5);

      expect(mockGet).toHaveBeenCalledTimes(5);
      expect(result.jobs).toHaveLength(20);
      const listLevel = result.jobs.filter((job) => job.description === null);
      expect(listLevel).toHaveLength(15);
      // The truth is each posting's own detail `startDate`, recorded for all 20 rows.
      expect(result.jobs.map((job) => [job.id, job.datePosted])).toEqual(
        result.jobs.map((job) => [job.id, START_DATE.get(job.id ?? '')]),
      );
      // Rows 6-20: six "Posted Yesterday", four "2 Days Ago", five "3 Days Ago".
      expect(listLevel.map((job) => job.datePosted)).toEqual([
        ...Array(6).fill('2026-09-24'),
        ...Array(4).fill('2026-09-23'),
        ...Array(5).fill('2026-09-22'),
      ]);
    });

    it('agrees with the enriched copy of every posting, either side of UTC midnight', async () => {
      // The recorded labels hold from 04:00 UTC on the 25th (midnight EDT) to 04:00 UTC on the 26th.
      for (const now of ['2026-09-25T23:59:59Z', '2026-09-26T00:00:01Z', '2026-09-26T00:42:22Z', '2026-09-26T03:59:59Z']) {
        serveDetails(DATES.details);
        const enriched = await scrapeAt(new Date(now), 20);
        const capped = await scrapeAt(new Date(now), 3);

        expect(enriched.jobs.every((job) => job.description !== null)).toBe(true);
        expect(capped.jobs.filter((job) => job.description === null)).toHaveLength(17);
        const enrichedDate = new Map(enriched.jobs.map((job) => [job.id, job.datePosted]));
        const disagreeing = capped.jobs.filter((job) => job.datePosted !== enrichedDate.get(job.id));
        expect([now, disagreeing.map((job) => `${job.id}: ${job.datePosted} vs ${enrichedDate.get(job.id)}`)]).toEqual([now, []]);
        jest.useRealTimers();
      }
    });

    it('reads a board ahead of UTC (Tokyo, 05:00 on the 26th) the same way', async () => {
      const page = {
        total: 4,
        jobPostings: [
          { title: 'Analyst A', externalPath: '/job/Tokyo/Analyst-A_R100', postedOn: 'Posted Today', bulletFields: ['R100'] },
          { title: 'Analyst B', externalPath: '/job/Tokyo/Analyst-B_R101', postedOn: 'Posted Today', bulletFields: ['R101'] },
          { title: 'Analyst C', externalPath: '/job/Tokyo/Analyst-C_R102', postedOn: 'Posted Yesterday', bulletFields: ['R102'] },
          { title: 'Analyst D', externalPath: '/job/Tokyo/Analyst-D_R103', postedOn: 'Posted 2 Days Ago', bulletFields: ['R103'] },
        ],
      };
      serveDetails([
        { externalPath: '/job/Tokyo/Analyst-A_R100', jobReqId: 'R100', postedOn: 'Posted Today', startDate: '2026-09-26' },
        { externalPath: '/job/Tokyo/Analyst-B_R101', jobReqId: 'R101', postedOn: 'Posted Today', startDate: '2026-09-26' },
      ]);

      const result = await scrapeAt(new Date('2026-09-25T20:00:00Z'), 2, page, 'tokyoco:3:Careers');

      expect(result.jobs.map((job) => [job.atsId, job.datePosted, job.description !== null])).toEqual([
        ['R100', '2026-09-26', true],
        ['R101', '2026-09-26', true],
        ['R102', '2026-09-25', false],
        ['R103', '2026-09-24', false],
      ]);
    });

    it("counts from the row's label, not the detail's, when the board's midnight passes during enrichment", async () => {
      // Listed at 03:59:50 UTC (23:59:50 EDT): the row still says "Posted Today";
      // the detail, fetched after midnight in Massachusetts, already says "Posted Yesterday".
      const page = {
        total: 2,
        jobPostings: [
          { title: 'Role A', externalPath: '/job/Norwood/Role-A_R200', postedOn: 'Posted Today', bulletFields: ['R200'] },
          { title: 'Role B', externalPath: '/job/Norwood/Role-B_R201', postedOn: 'Posted Yesterday', bulletFields: ['R201'] },
        ],
      };
      serveDetails([
        { externalPath: '/job/Norwood/Role-A_R200', jobReqId: 'R200', postedOn: 'Posted Yesterday', startDate: '2026-09-25' },
      ]);

      const result = await scrapeAt(new Date('2026-09-26T04:00:10Z'), 1, page, 'acme:1:Careers');

      expect(result.jobs.map((job) => [job.atsId, job.datePosted])).toEqual([
        ['R200', '2026-09-25'],
        ['R201', '2026-09-24'],
      ]);
    });

    it("ignores a detail whose startDate is more than a day off its row's label (a repost)", async () => {
      const page = clone(LIST);
      const details = DATES.details.map((d) => ({ ...d }));
      // The newest row is a repost: "Posted Today" on the list, the original start date in the detail.
      details[0].startDate = '2026-08-03';

      serveDetails(details);
      const result = await scrapeAt(RECORDED_AT, 4, page);

      expect(result.jobs[0].datePosted).toBe('2026-08-03');
      const listLevel = result.jobs.filter((job) => job.description === null);
      expect(listLevel).toHaveLength(16);
      expect(listLevel.map((job) => job.datePosted)).toEqual(listLevel.map((job) => START_DATE.get(job.id ?? '')));
    });

    it('falls back to the UTC calendar when no enriched posting dates the board', async () => {
      // No detail request at all, or details without a startDate: nothing to count from.
      const noDetails = await scrapeAt(RECORDED_AT, 0);
      serveDetails(DATES.details.map((d) => ({ ...d, startDate: null })));
      const noStartDate = await scrapeAt(RECORDED_AT, 5);

      for (const result of [noDetails, noStartDate]) {
        expect(result.jobs).toHaveLength(20);
        expect(result.jobs[0].datePosted).toBe('2026-09-26');
        expect(result.jobs[19].datePosted).toBe('2026-09-23');
      }
    });
  });

  describe('remote location underscore normalization — Spec 5025', () => {
    it('detects isRemote when the only location label is slugified ("Remote_USA")', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          total: 1,
          jobPostings: [
            {
              title: 'Technical Sales Representative',
              externalPath:
                '/job/Remote_USA/Technical-Sales-Representative_JR002273',
              locationsText: 'Remote_USA',
              postedOn: 'Posted Today',
            },
          ],
        },
      });
      // Detail unavailable (matches the live case): info is undefined, so the
      // summary "Remote_USA" label is the only remote signal.
      mockGet.mockResolvedValueOnce({ data: {} });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'zekelman:12:Careers',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].isRemote).toBe(true);
      expect(result.jobs[0].location?.city ?? '').not.toContain('_');
      expect(result.jobs[0].location?.country).toBe('United States');
    });
  });
});
