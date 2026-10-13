import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper reads the captured careers-page
// fixture instead of www.comeet.com.
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

import { ComeetService } from '../src';

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'comeet-careers.html'),
  'utf8',
);

const input = (over: Partial<ScraperInputDto> = {}) =>
  ({
    siteType: [Site.COMEET],
    companySlug: 'covenantindustries',
    resultsWanted: 50,
    ...over,
  }) as ScraperInputDto;

describe('ComeetService — captured careers-page fixture', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockGet.mockResolvedValue({ data: FIXTURE });
  });

  it('maps COMPANY_POSITIONS_DATA items to JobPostDto', async () => {
    const result = await new ComeetService().scrape(input());

    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toHaveLength(2);
    expect(result.diagnostics).toBeUndefined();

    const first = result.jobs[0];
    expect(first.id).toBe('comeet-covenantindustries-94.F6D');
    expect(first.site).toBe(Site.COMEET);
    expect(first.title).toBe('Communications Software Engineer');
    expect(first.companyName).toBe('Covenant Industries');
    expect(first.jobUrl).toBe(
      'https://www.comeet.com/jobs/covenantindustries/3B.00F/communications-software-engineer/94.F6D',
    );
    expect(first.applyUrl).toBe(first.jobUrl);
    expect(first.department).toBe('Software');
    expect(first.datePosted).toBe('2026-09-09T15:39:02Z');
    expect(first.description).toBeTruthy();
    expect(first.description).not.toContain('<');
    expect(first.isRemote).toBe(false);
    expect(first.atsId).toBe('94.F6D');
    expect(first.atsType).toBe('comeet');
  });

  it('parses the embedded location geo-label via textKeys + parseTextFallback', async () => {
    const result = await new ComeetService().scrape(input());
    const first = result.jobs[0];

    // "Grand Prairie, Texas, USA" — name claimed as text, parsed into slots
    // (the parser canonicalizes the state name to its code).
    expect(first.location).toMatchObject({
      text: 'Grand Prairie, Texas, USA',
      city: 'Grand Prairie',
      state: 'TX',
    });
    expect(first.location?.country).toMatch(/^(US|United States)$/);
    expect(first.locations).toHaveLength(1);
    // Unclaimed structured keys ride extras verbatim.
    expect(first.location?.extras).toMatchObject({
      timezone: 'America/Chicago',
      location_uid: 'BB.60D',
      is_remote: false,
    });
  });

  it('maps structured location fields directly (postal_code, city, state)', async () => {
    const result = await new ComeetService().scrape(input());
    const second = result.jobs[1];

    expect(second.location).toMatchObject({
      city: 'Washington, D.C.',
      state: 'DC',
      postalCode: '20001',
    });
    expect(second.location?.extras).toMatchObject({
      street_name: '444 N Capitol St NW Suite 603',
      location_uid: 'BB.60E',
    });
  });

  it('honours resultsWanted', async () => {
    const result = await new ComeetService().scrape(input({ resultsWanted: 1 }));
    expect(result.jobs).toHaveLength(1);
  });

  it('fetches companyUrl when provided instead of the slug board URL', async () => {
    await new ComeetService().scrape(
      input({ companyUrl: 'https://covenant.com/careers' }),
    );
    expect(mockGet).toHaveBeenCalledWith('https://covenant.com/careers');
  });

  it('fetches the slug board URL by default', async () => {
    await new ComeetService().scrape(input());
    expect(mockGet).toHaveBeenCalledWith(
      'https://www.comeet.com/jobs/covenantindustries',
    );
  });
});

describe('ComeetService — inline pages', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
  });

  const page = (positions: unknown) =>
    `<html><script>var COMPANY_DATA={"name":"Acme"};var COMPANY_POSITIONS_DATA=${JSON.stringify(positions)};</script></html>`;

  it('marks isRemote from location.is_remote', async () => {
    mockGet.mockResolvedValue({
      data: page([
        {
          name: 'Remote Engineer',
          uid: 'X1',
          url_active_page: 'https://example.com/j/1',
          location: { name: 'Remote', is_remote: true },
          workplace_type: 'Remote',
        },
      ]),
    });
    const result = await new ComeetService().scrape(input());
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].isRemote).toBe(true);
  });

  it('marks isRemote from workplace_type alone', async () => {
    mockGet.mockResolvedValue({
      data: page([
        {
          name: 'Remote Analyst',
          uid: 'X2',
          url_active_page: 'https://example.com/j/2',
          location: { name: 'Austin, TX', is_remote: false },
          workplace_type: 'Remote - US',
        },
      ]),
    });
    const result = await new ComeetService().scrape(input());
    expect(result.jobs[0].isRemote).toBe(true);
  });

  it('returns an empty response for a page without comeet markers', async () => {
    mockGet.mockResolvedValue({ data: '<html><body>Not a comeet board</body></html>' });
    const result = await new ComeetService().scrape(input());
    expect(result.jobs).toHaveLength(0);
    expect(result.diagnostics).toBeUndefined();
  });

  it('classifies a fetch failure and preserves accumulated jobs', async () => {
    mockGet.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const result = await new ComeetService().scrape(input());
    expect(result.jobs).toHaveLength(0);
    expect(result.diagnostics).toBeDefined();
  });

  it('returns empty when companySlug is missing', async () => {
    const result = await new ComeetService().scrape(
      input({ companySlug: undefined }),
    );
    expect(result.jobs).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
