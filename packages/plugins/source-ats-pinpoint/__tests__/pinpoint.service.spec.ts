import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

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

import { PinpointModule, PinpointService } from '../src';

const COMPANY = 'impulsespace';
const EXPECTED_URL = `https://${COMPANY}.pinpointhq.com/postings.json`;

function posting(overrides: Record<string, any> = {}) {
  return {
    id: '123',
    title: 'Default Title',
    url: `https://${COMPANY}.pinpointhq.com/en/postings/123`,
    description: '<p>Do work.</p>',
    location: { name: 'Onsite City', city: 'Onsite City', province: 'State' },
    workplace_type: 'onsite',
    published_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Spec 5090 — Pinpoint location is an object and workplace_type drives remote
 * detection. Mocked HTTP client asserts the plugin maps both shapes without
 * throwing.
 */
describe('PinpointService — Spec 5090', () => {
  let service: PinpointService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PinpointModule],
    }).compile();
    service = moduleRef.get(PinpointService);
  });

  beforeEach(() => {
    mockGet.mockReset();
  });

  async function scrape(postings: any[], opts: Partial<ScraperInputDto> = {}) {
    mockGet.mockResolvedValueOnce({ data: { data: postings } });
    const input = new ScraperInputDto({
      siteType: [Site.PINPOINT],
      companySlug: COMPANY,
      resultsWanted: 100,
      ...opts,
    });
    const response: JobResponseDto = await service.scrape(input);
    expect(mockGet).toHaveBeenCalledWith(EXPECTED_URL);
    return response;
  }

  it('parses object location and derives state from province', async () => {
    const response = await scrape([
      posting({
        id: '290785',
        title: 'Senior Development Test Engineer',
        location: {
          id: '6679',
          name: 'Redondo Beach ',
          city: 'Redondo Beach',
          province: 'California',
          postal_code: '90278',
          street_address: '',
        },
        workplace_type: 'onsite',
      }),
    ]);

    expect(response.jobs).toHaveLength(1);
    const job = response.jobs[0];
    expect(job.title).toBe('Senior Development Test Engineer');
    expect(job.location?.city).toBe('Redondo Beach');
    expect(job.location?.state).toBe('California');
    expect(job.isRemote).toBe(false);
    expect(job.description).toBe('Do work.');
  });

  it('sets isRemote true for workplace_type remote', async () => {
    const response = await scrape([
      posting({
        id: '290786',
        title: 'Remote Propulsion Engineer',
        location: { name: 'Remote - US', city: 'Remote - US', province: '' },
        workplace_type: 'remote',
      }),
    ]);

    expect(response.jobs).toHaveLength(1);
    expect(response.jobs[0].isRemote).toBe(true);
    expect(response.jobs[0].location?.city).toBe('Remote - US');
    expect(response.jobs[0].location?.state).toBeUndefined();
  });

  it('still handles string location and boolean remote', async () => {
    const response = await scrape([
      posting({
        id: '290787',
        title: 'String Location Job',
        location: 'Remote',
        remote: true,
        workplace_type: 'onsite',
      }),
    ]);

    expect(response.jobs).toHaveLength(1);
    expect(response.jobs[0].isRemote).toBe(true);
    expect(response.jobs[0].location?.city).toBe('Remote');
  });

  it('honours resultsWanted', async () => {
    const response = await scrape(
      [posting({ id: '1' }), posting({ id: '2' }), posting({ id: '3' })],
      { resultsWanted: 2 },
    );

    expect(response.jobs).toHaveLength(2);
  });

  it('returns empty when companySlug is missing', async () => {
    const input = new ScraperInputDto({ siteType: [Site.PINPOINT] });
    const response = await service.scrape(input);
    expect(response.jobs).toHaveLength(0);
  });

  it('constructs a fallback jobUrl when url is absent', async () => {
    const response = await scrape([
      posting({ id: '290788', title: 'Fallback URL Job', url: undefined }),
    ]);

    expect(response.jobs[0].jobUrl).toBe(
      `https://${COMPANY}.pinpointhq.com/postings/290788`,
    );
  });
});
