import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DescriptionFormat, ScraperInputDto, Site } from '@ever-jobs/models';

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

import { WorkdayModule } from '../src/workday.module';
import { WorkdayService } from '../src/workday.service';
import {
  ATS_COUNTRY_OVERLAY_ENV_VAR,
  DEFAULT_WORKDAY_MAX_DETAIL_FETCHES,
  DEFAULT_WORKDAY_SCRAPE_TIME_BUDGET_MS,
  WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR,
  WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR,
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
      expect(job.companyName).toBe('X-Energy, LLC');
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

    it('falls back to the tenant slug when hiringOrganization.name is blank', async () => {
      const detail = clone(DETAIL);
      detail.hiringOrganization.name = '   ';
      mockPost.mockResolvedValueOnce({ data: clone(DETAIL_PAGE) });
      mockGet.mockResolvedValueOnce({ data: detail });

      const result = await new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
      } as ScraperInputDto);

      expect(result.jobs[0].companyName).toBe('xenergy');
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
      expect(result.jobs[1].companyName).toBe('X-Energy, LLC');
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
      expect(job.location?.country == null).toBe(true);
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

    beforeEach(() => {
      clock = T0;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      delete process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR];
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env[WORKDAY_MAX_DETAIL_FETCHES_ENV_VAR];
      delete process.env[WORKDAY_SCRAPE_TIME_BUDGET_ENV_VAR];
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
      expect(enriched.companyName).toBe('Acme Corp');
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
