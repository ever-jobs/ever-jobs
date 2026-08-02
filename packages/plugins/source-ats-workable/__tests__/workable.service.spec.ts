import 'reflect-metadata';
import {
  DescriptionFormat,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { WorkableService } from '../src/workable.service';

const WIDGET = 'api/v1/widget/accounts';
const DETAIL = 'api/v2/accounts';

function widgetJob(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Gait Control Engineer',
    shortcode: 'CE4DD737B9',
    employment_type: 'Full-time',
    telecommuting: false,
    function: 'Engineering',
    department: null,
    published_on: '2026-03-26',
    locations: [
      {
        country: 'United States',
        city: 'Austin',
        region: 'Texas',
      },
    ],
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    shortcode: 'CE4DD737B9',
    description: '<p>Build the gait control stack.</p>',
    requirements: '<ul><li>5y robotics</li></ul>',
    benefits: '<ul><li>Equity</li></ul>',
    workplace: 'on_site',
    remote: false,
    ...overrides,
  };
}

/** Route mocked GETs to the widget list or the per-job detail by URL. */
function routeGet(
  jobs: unknown[],
  details: Record<string, unknown>,
  widget: Record<string, unknown> = {},
) {
  mockGet.mockImplementation(async (url: string) => {
    if (url.includes(WIDGET)) return { data: { ...widget, jobs } };
    if (url.includes(DETAIL)) {
      const code = url.split('/jobs/')[1];
      return { data: details[code] ?? null };
    }
    return { data: null };
  });
}

describe('WorkableService public path', () => {
  beforeEach(() => mockGet.mockReset());

  async function scrapeOne(overrides: {
    job?: Record<string, unknown>;
    detail?: Record<string, unknown> | null;
    format?: DescriptionFormat;
  }) {
    const job = widgetJob(overrides.job);
    const details: Record<string, unknown> = {};
    if (overrides.detail !== null) {
      details[job.shortcode as string] = detail(overrides.detail ?? {});
    }
    routeGet([job], details);
    const res = await new WorkableService().scrape({
      companySlug: 'shift-robotics',
      siteType: [Site.WORKABLE],
      resultsWanted: 10,
      descriptionFormat: overrides.format,
    } as ScraperInputDto);
    return res.jobs[0];
  }

  it('overlays the v2 detail and concatenates description/requirements/benefits', async () => {
    const post = await scrapeOne({ format: DescriptionFormat.PLAIN });
    expect(post.description).toContain('Build the gait control stack.');
    expect(post.description).toContain('5y robotics');
    expect(post.description).toContain('Equity');
  });

  it('maps function to jobFunction', async () => {
    const post = await scrapeOne({});
    expect(post.jobFunction).toBe('Engineering');
  });

  it('sets workFromHomeType=Hybrid from workplace and leaves isRemote false', async () => {
    const post = await scrapeOne({ detail: { workplace: 'hybrid' } });
    expect(post.workFromHomeType).toBe('Hybrid');
    expect(post.isRemote).toBe(false);
  });

  it('treats workplace=remote as remote with Remote work mode', async () => {
    const post = await scrapeOne({ detail: { workplace: 'remote', remote: true } });
    expect(post.workFromHomeType).toBe('Remote');
    expect(post.isRemote).toBe(true);
  });

  it('omits workFromHomeType for on_site', async () => {
    const post = await scrapeOne({ detail: { workplace: 'on_site' } });
    expect(post.workFromHomeType).toBeUndefined();
  });

  it('still maps core fields when the detail fetch yields nothing', async () => {
    const post = await scrapeOne({ detail: null });
    expect(post.title).toBe('Gait Control Engineer');
    expect(post.description).toBeNull();
    expect(post.jobFunction).toBe('Engineering');
    expect(post.jobType).toEqual([JobType.FULL_TIME]);
    expect(post.site).toBe(Site.WORKABLE);
    expect(post.atsType).toBe('workable');
  });

  it('parses a salary range from the detail body (Spec 5018)', async () => {
    const post = await scrapeOne({
      detail: {
        description:
          '<p>The base pay range is $120,000 - $160,000 per year.</p>',
      },
    });
    expect(post.compensation?.minAmount).toBe(120000);
    expect(post.compensation?.maxAmount).toBe(160000);
    expect(post.compensation?.currency).toBe('USD');
  });

  it('leaves compensation undefined when the body has no salary (Spec 5018)', async () => {
    const post = await scrapeOne({
      detail: { description: '<p>Join a great team. 5+ years required.</p>' },
    });
    expect(post.compensation).toBeUndefined();
  });

  it('leaves compensation undefined when the detail fetch yields nothing (Spec 5018)', async () => {
    const post = await scrapeOne({ detail: null });
    expect(post.compensation).toBeUndefined();
  });

  it('uses the widget display name as companyName, not the slug (Spec 5031)', async () => {
    const job = widgetJob();
    routeGet([job], { [job.shortcode]: detail() }, { name: 'Shift Robotics' });
    const res = await new WorkableService().scrape({
      companySlug: 'shift-robotics',
      siteType: [Site.WORKABLE],
      resultsWanted: 10,
    } as ScraperInputDto);
    expect(res.jobs[0].companyName).toBe('Shift Robotics');
    // Slug-derived fields are unchanged.
    expect(res.jobs[0].atsId).toBe('CE4DD737B9');
  });

  it('falls back to the slug when the widget has no name (Spec 5031)', async () => {
    const job = widgetJob();
    routeGet([job], { [job.shortcode]: detail() });
    const res = await new WorkableService().scrape({
      companySlug: 'shift-robotics',
      siteType: [Site.WORKABLE],
      resultsWanted: 10,
    } as ScraperInputDto);
    expect(res.jobs[0].companyName).toBe('shift-robotics');
  });

  it('returns empty results when no companySlug is provided', async () => {
    const res = await new WorkableService().scrape({
      siteType: [Site.WORKABLE],
    } as ScraperInputDto);
    expect(res.jobs.length).toBe(0);
  });
});
