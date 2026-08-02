import 'reflect-metadata';
import {
  CompensationInterval,
  DescriptionFormat,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: mockPost,
      setHeaders: jest.fn(),
    })),
  };
});

import { PaycomService } from '../src/paycom.service';
import {
  PaycomJobPosting,
  PaycomJobPreview,
} from '../src/paycom.types';

const CLIENTKEY = '03A0C40668106F27C234F910C58A5717';
const JWT = 'header.payload.signature';
const BOARD_RE = new RegExp(`/portal/${CLIENTKEY}/career-page$`);
const COMPANY_NAME_RE = /\/api\/ats\/company-name$/;
const DETAIL_RE = /\/api\/ats\/job-postings\/([^/?]+)$/;

/** Board HTML carrying the page-embedded bearer the React app boots. */
function boardHtml(jwt: string | null = JWT): string {
  const cfg = jwt
    ? `{"configsFromHost":{"sessionJWT":"${jwt}","other":1}}`
    : `{"configsFromHost":{"other":1}}`;
  return `<!doctype html><html><head><script>window.__BOOT__=${cfg}</script></head><body>Loading…</body></html>`;
}

/** A schema.org JobPosting carried as a JSON string in googleJobJson. */
function googleJobJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Production Technician',
    datePosted: '2026-06-20T00:00:00-05:00',
    url: `https://www.paycomonline.net/v4/ats/web.php/portal/${CLIENTKEY}/jobs/60339`,
    ...over,
  });
}

function preview(over: Partial<PaycomJobPreview> = {}): PaycomJobPreview {
  return {
    jobId: 60339,
    jobTitle: 'Production Technician',
    locations: 'Seymour, IN 47274',
    remoteType: '',
    ...over,
  };
}

function posting(over: Partial<PaycomJobPosting> = {}): PaycomJobPosting {
  return {
    jobId: 60339,
    jobTitle: 'Production Technician',
    location: 'Seymour, IN 47274',
    positionType: 'Full Time',
    jobCategory: 'Manufacturing',
    remoteType: '',
    salaryRange: '',
    description: '<p>Build the bikes.</p>',
    qualifications: '<ul><li>2 years experience</li></ul>',
    googleJobJson: googleJobJson(),
    ...over,
  };
}

/**
 * Route the mocked client: board page → token HTML; company-name → display name;
 * search → previews envelope; per-id detail → `{ jobPosting }` envelope.
 */
function mockApi(opts: {
  board?: string | null;
  companyName?: string | null;
  previews?: PaycomJobPreview[];
  detailById?: Record<string, PaycomJobPosting | Error>;
}) {
  const {
    board = boardHtml(),
    companyName = 'Guardian Bikes',
    previews = [preview()],
    detailById = { '60339': posting() },
  } = opts;

  mockGet.mockImplementation((url: string) => {
    if (BOARD_RE.test(url)) {
      return board == null
        ? Promise.reject(makeHttpError(404))
        : Promise.resolve({ data: board });
    }
    if (COMPANY_NAME_RE.test(url)) {
      return Promise.resolve({ data: { companyName } });
    }
    const detail = url.match(DETAIL_RE);
    if (detail) {
      const entry = detailById[decodeURIComponent(detail[1])];
      if (entry == null) return Promise.reject(makeHttpError(404));
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve({ data: { jobPosting: entry } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  mockPost.mockImplementation((url: string) => {
    if (url.includes('/api/ats/job-posting-previews/search')) {
      return Promise.resolve({ data: { jobPostingPreviews: previews, jobPostingPreviewsCount: previews.length } });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

function makeHttpError(status: number): Error {
  const err = new Error(`HTTP ${status}`) as Error & { response?: { status: number } };
  err.response = { status };
  return err;
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    companySlug: CLIENTKEY,
    siteType: [Site.PAYCOM],
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

describe('PaycomService', () => {
  let service: PaycomService;

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    service = new PaycomService();
  });

  it('maps the real API envelope, token, company-name, body and date', async () => {
    mockApi({});

    const res = await service.scrape(input({ descriptionFormat: DescriptionFormat.PLAIN }));

    expect(res.jobs).toHaveLength(1);
    const job = res.jobs[0];
    expect(job.title).toBe('Production Technician');
    // company name comes from /api/ats/company-name, not the clientkey
    expect(job.companyName).toBe('Guardian Bikes');
    // description is description + qualifications concatenated
    expect(job.description).toContain('Build the bikes.');
    expect(job.description).toContain('2 years experience');
    expect(job.location?.city).toBe('Seymour');
    expect(job.location?.state).toBe('IN');
    expect(job.employmentType).toBe('Full Time');
    expect(job.department).toBe('Manufacturing');
    expect(job.isRemote).toBe(false);
    // datePosted lives only inside googleJobJson
    expect(job.datePosted).toBe('2026-06-20');
    expect(job.site).toBe(Site.PAYCOM);
    expect(job.atsType).toBe('paycom');
    expect(job.atsId).toBe('60339');
    expect(job.id).toBe('paycom-60339');
    expect(job.jobUrl).toContain('/jobs/60339');
    expect(job.applyUrl).toContain('/jobs/60339');
  });

  it('POSTs the search with the full filtersForQuery object', async () => {
    mockApi({});

    await service.scrape(input());

    expect(mockPost).toHaveBeenCalledWith(
      expect.stringContaining('/api/ats/job-posting-previews/search'),
      expect.objectContaining({
        skip: 0,
        take: expect.any(Number),
        filtersForQuery: expect.objectContaining({ workEnvironments: [], categories: [] }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${JWT}` }),
      }),
    );
  });

  it('reads structured compensation from the googleJobJson baseSalary', async () => {
    mockApi({
      detailById: {
        '60339': posting({
          googleJobJson: googleJobJson({
            baseSalary: {
              '@type': 'MonetaryAmount',
              currency: 'USD',
              value: { '@type': 'QuantitativeValue', minValue: 60000, maxValue: 80000, unitText: 'YEAR' },
            },
          }),
        }),
      },
    });

    const res = await service.scrape(input());

    expect(res.jobs[0].compensation).toMatchObject({
      minAmount: 60000,
      maxAmount: 80000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
    expect(res.jobs[0].salarySource).toBe('structured');
  });

  it('detects a remote role from the remoteType code', async () => {
    mockApi({
      previews: [preview({ remoteType: 'R' })],
      detailById: { '60339': posting({ remoteType: 'R', location: 'Remote' }) },
    });

    const res = await service.scrape(input());

    expect(res.jobs[0].isRemote).toBe(true);
    expect(res.jobs[0].workFromHomeType).toBe('Remote');
  });

  it('resolves the clientkey from a board companyUrl (portal path or query)', async () => {
    mockApi({});

    const fromPath = await service.scrape(
      input({
        companySlug: undefined,
        companyUrl: `https://www.paycomonline.net/v4/ats/web.php/portal/${CLIENTKEY}/career-page`,
      }),
    );
    expect(fromPath.jobs).toHaveLength(1);

    const fromQuery = await service.scrape(
      input({
        companySlug: undefined,
        companyUrl: `https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=${CLIENTKEY}`,
      }),
    );
    expect(fromQuery.jobs).toHaveLength(1);
  });

  it('returns empty when the board exposes no sessionJWT', async () => {
    mockApi({ board: boardHtml(null) });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
    // never reaches the search API without a token
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('returns empty for an unknown tenant (board 404)', async () => {
    mockApi({ board: null });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
  });

  it('returns empty when neither companySlug nor companyUrl is provided', async () => {
    mockApi({});

    const res = await service.scrape(input({ companySlug: undefined, companyUrl: undefined }));

    expect(res.jobs).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('still maps a job when its detail fetch fails (preview-only fallback)', async () => {
    mockApi({ detailById: { '60339': makeHttpError(404) } });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Production Technician');
    expect(res.jobs[0].companyName).toBe('Guardian Bikes');
    expect(res.jobs[0].description).toBeNull();
  });

  it('dedupes by jobId and respects resultsWanted', async () => {
    mockApi({
      previews: [preview({ jobId: 1 }), preview({ jobId: 1 }), preview({ jobId: 2 }), preview({ jobId: 3 })],
      detailById: {
        '1': posting({ jobId: 1 }),
        '2': posting({ jobId: 2 }),
        '3': posting({ jobId: 3 }),
      },
    });

    const res = await service.scrape(input({ resultsWanted: 2 }));

    expect(res.jobs.map((j) => j.atsId)).toEqual(['1', '2']);
  });
});
