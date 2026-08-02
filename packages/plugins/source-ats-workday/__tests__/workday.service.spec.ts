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
  };
});

import { WorkdayModule } from '../src/workday.module';
import { WorkdayService } from '../src/workday.service';

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
      expect(job?.jobUrl).toBe(
        'https://tesla.wd5.myworkdayjobs.com/job/Austin-TX/Software-Engineer_R-101/12345',
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

    it('starts no more than five detail requests before the first batch settles', async () => {
      const page = {
        total: 6,
        jobPostings: Array.from({ length: 6 }, (_, index) => ({
          title: `Role ${index}`,
          externalPath: `/job/Location/Role-${index}_R${index}`,
          locationsText: 'Rockville, MD',
        })),
      };
      mockPost.mockResolvedValueOnce({ data: page });

      const resolvers: Array<() => void> = [];
      mockGet.mockImplementation(
        () => new Promise((resolve) => resolvers.push(() => resolve({ data: {} }))),
      );

      const scrapePromise = new WorkdayService().scrape({
        siteType: [Site.WORKDAY],
        companySlug: 'xenergy:5:X-energyUS',
      } as ScraperInputDto);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockGet).toHaveBeenCalledTimes(5);

      resolvers.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockGet).toHaveBeenCalledTimes(6);
      resolvers.splice(0).forEach((resolve) => resolve());

      const result = await scrapePromise;
      expect(result.jobs).toHaveLength(6);
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
    });

    it('folds the ISO-2 country code into the location via regionNameFromCode', async () => {
      const job = await scrapeWith(
        detail({ location: 'Rockville, MD', additionalLocations: [] }),
      );
      expect(job.location?.country).toBe('United States');
    });

    it('leaves country unset when no alpha2Code is present', async () => {
      const job = await scrapeWith(
        detail({ location: 'Rockville, MD', additionalLocations: [], jobRequisitionLocation: null }),
      );
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
      expect(result.jobs[0].location?.city).not.toContain('_');
    });
  });
});
