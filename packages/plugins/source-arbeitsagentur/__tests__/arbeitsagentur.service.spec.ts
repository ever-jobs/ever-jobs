import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits the captured response fixture
// instead of jobsuche.api.bund.dev.
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

import { ArbeitsagenturService } from '../src';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'arbeitsagentur-response.json'),
    'utf8',
  ),
);

describe('ArbeitsagenturService — captured response fixture', () => {
  beforeEach(() => {
    process.env.ARBEITSAGENTUR_API_KEY = 'test-key';
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockGet.mockResolvedValue({ data: FIXTURE });
  });

  it('maps arbeitsort through the location-object mapper', async () => {
    const service = new ArbeitsagenturService();
    const result = await service.scrape({
      siteType: [Site.ARBEITSAGENTUR],
      resultsWanted: 10,
    } as ScraperInputDto);

    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toHaveLength(2);

    const first = result.jobs[0];
    expect(first.location).toMatchObject({
      city: 'München',
      state: 'Bayern',
      country: 'Deutschland',
      postalCode: '80331',
    });
    // koordinaten is unclaimed → extras verbatim.
    expect(first.location?.extras).toMatchObject({
      koordinaten: { lat: 48.1372, lon: 11.5755 },
    });
    expect(first.isRemote).toBe(false);

    const second = result.jobs[1];
    expect(second.location).toMatchObject({ city: 'Berlin', postalCode: '10115' });
    expect(second.isRemote).toBe(true);
  });
});
