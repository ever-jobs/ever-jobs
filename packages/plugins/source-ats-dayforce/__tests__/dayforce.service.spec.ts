import 'reflect-metadata';
import {
  DescriptionFormat,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn((..._args: unknown[]) => ({
  get: mockGet,
  post: mockPost,
  setHeaders: mockSetHeaders,
}));

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args),
  };
});

import { DayforceService } from '../src/dayforce.service';

const csrfToken = 'test-csrf-token';

function csrfResponse(token: string | null = csrfToken) {
  return {
    data: token == null ? {} : { csrfToken: token },
    headers: {
      'set-cookie': [
        '__Host-next-auth.csrf-token=abc123; Path=/; Secure; HttpOnly; SameSite=lax',
      ],
    },
  };
}

function searchResponse(postings: unknown[] = []) {
  return {
    data: {
      jobPostings: postings,
      maxCount: postings.length,
      count: postings.length,
    },
  };
}

function makePosting(overrides: Record<string, unknown> = {}) {
  return {
    jobPostingId: '123',
    jobTitle: 'Propulsion Engineer',
    jobDescription: '<p>Build engines.</p>',
    postingLocations: [
      {
        city: 'Denver',
        state: 'CO',
        country: 'USA',
      },
    ],
    ...overrides,
  };
}

function input(
  overrides: Partial<ScraperInputDto> = {},
): ScraperInputDto {
  return {
    siteType: [Site.DAYFORCE],
    companySlug: 'yss',
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

describe('DayforceService', () => {
  let service: DayforceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DayforceService();
  });

  it('requests a CSRF token and sends it on the geo search POST', async () => {
    mockGet.mockResolvedValue(csrfResponse());
    mockPost.mockResolvedValue(searchResponse([makePosting()]));

    const res = await service.scrape(input());

    expect(mockCreateHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ cookies: true }),
    );

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(
      'https://jobs.dayforcehcm.com/api/auth/csrf',
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: 'https://jobs.dayforcehcm.com/en-US/yss/CANDIDATEPORTAL',
        }),
      }),
    );

    expect(mockSetHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        'X-CSRF-TOKEN': csrfToken,
        Referer: 'https://jobs.dayforcehcm.com/en-US/yss/CANDIDATEPORTAL',
      }),
    );

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe(
      'https://jobs.dayforcehcm.com/api/geo/yss/jobposting/search',
    );

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Propulsion Engineer');
    expect(res.jobs[0].site).toBe(Site.DAYFORCE);
    expect(res.jobs[0].atsType).toBe('dayforce');
    expect(res.jobs[0].atsId).toBe('123');
  });

  it('reuses the companyUrl path as the portal Referer when provided', async () => {
    const companyUrl = 'https://jobs.dayforcehcm.com/en-US/yss/CANDIDATEPORTAL';
    mockGet.mockResolvedValue(csrfResponse());
    mockPost.mockResolvedValue(searchResponse([makePosting()]));

    await service.scrape(input({ companyUrl }));

    expect(mockGet).toHaveBeenCalledWith(
      'https://jobs.dayforcehcm.com/api/auth/csrf',
      expect.objectContaining({
        headers: expect.objectContaining({ Referer: companyUrl }),
      }),
    );
    expect(mockSetHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        'X-CSRF-TOKEN': csrfToken,
        Referer: companyUrl,
      }),
    );
  });

  it('maps search response postings into JobPostDto entries', async () => {
    mockGet.mockResolvedValue(csrfResponse());
    mockPost.mockResolvedValue(
      searchResponse([
        makePosting({ jobPostingId: '1', jobTitle: 'Senior Engineer' }),
        makePosting({ jobPostingId: '2', jobTitle: 'Technician' }),
      ]),
    );

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(2);
    expect(res.jobs[0].title).toBe('Senior Engineer');
    expect(res.jobs[1].title).toBe('Technician');
  });

  it('returns a blocked diagnostic when the CSRF request is rejected with 403', async () => {
    mockGet.mockRejectedValue(
      new Error('Request failed with status code 403'),
    );
    mockPost.mockResolvedValue(searchResponse());

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('blocked');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('returns an unknown diagnostic when the CSRF response has no token', async () => {
    mockGet.mockResolvedValue(csrfResponse(null));
    mockPost.mockResolvedValue(searchResponse());

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('unknown');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('paginates through offsets until resultsWanted is satisfied', async () => {
    mockGet.mockResolvedValue(csrfResponse());

    const firstPage = Array.from({ length: 25 }, (_, i) =>
      makePosting({ jobPostingId: `${i}`, jobTitle: `Job ${i}` }),
    );
    const secondPage = Array.from({ length: 5 }, (_, i) =>
      makePosting({ jobPostingId: `${25 + i}`, jobTitle: `Job ${25 + i}` }),
    );

    mockPost
      .mockResolvedValueOnce({
        data: {
          jobPostings: firstPage,
          maxCount: 30,
          count: 30,
        },
      })
      .mockResolvedValueOnce({
        data: {
          jobPostings: secondPage,
          maxCount: 30,
          count: 30,
        },
      });

    const res = await service.scrape(input({ resultsWanted: 30 }));

    expect(res.jobs).toHaveLength(30);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[1][1]).toMatchObject({
      paginationStart: 25,
    });
  });

  it('passes the requested description format through to the mapper', async () => {
    mockGet.mockResolvedValue(csrfResponse());
    mockPost.mockResolvedValue(searchResponse([makePosting()]));

    const res = await service.scrape(
      input({ descriptionFormat: DescriptionFormat.PLAIN }),
    );

    expect(res.jobs[0].description).toBe('Build engines.');
  });
});
