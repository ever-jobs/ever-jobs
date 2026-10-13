import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits the captured feed fixture
// instead of api.recruitly.io.
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

import { RecruitlyService } from '../src';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'recruitly-feed.json'),
    'utf8',
  ),
);

describe('RecruitlyService — captured feed fixture', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockGet.mockResolvedValue({ data: FIXTURE });
  });

  it('maps structured locations through the location-object mapper', async () => {
    const service = new RecruitlyService();
    const result = await service.scrape({
      siteType: [Site.RECRUITLY],
      companySlug: 'test-board-key',
      resultsWanted: 10,
    } as ScraperInputDto);

    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toHaveLength(2);

    const first = result.jobs[0];
    expect(first.location).toMatchObject({
      city: 'London',
      state: 'Greater London',
      country: 'United Kingdom',
      streetAddress: '1 Threadneedle Street',
      postalCode: 'EC2R 8AH',
    });
    // Unclaimed keys ride extras verbatim (carry-all).
    expect(first.location?.extras).toMatchObject({
      latitude: 51.5136,
      longitude: -0.089,
    });
    expect(first.locations).toHaveLength(1);
    expect(first.locations?.[0]).toBe(first.location);

    // Second row: countryCode is claimed when countryName is absent.
    const second = result.jobs[1];
    expect(second.location).toMatchObject({
      city: 'Manchester',
      state: 'Greater Manchester',
      country: 'GB',
    });
    expect(second.isRemote).toBe(true);
  });
});
