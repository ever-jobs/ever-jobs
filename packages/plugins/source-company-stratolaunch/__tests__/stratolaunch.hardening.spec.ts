import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, setHeaders: jest.fn() })),
  };
});

import { StratolaunchService } from '../src';

/**
 * Guards for the two hardening changes applied on top of Spec 5089: the
 * entity-decode loop is bounded, and the board token is checked before it is
 * interpolated into the Greenhouse API path.
 */
describe('StratolaunchService — hardening', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  function boardUrlFor(slugOrUrl: Partial<ScraperInputDto>): Promise<string> {
    mockGet.mockResolvedValueOnce({ data: { jobs: [] } });
    const service = new StratolaunchService();
    return service
      .scrape({ siteType: [Site.STRATOLAUNCH], ...slugOrUrl } as ScraperInputDto)
      .then(() => mockGet.mock.calls[0][0] as string);
  }

  describe('board token validation', () => {
    it('reads its own board when no slug is given', async () => {
      await expect(boardUrlFor({})).resolves.toBe(
        'https://api.greenhouse.io/v1/boards/stratolaunch/jobs?content=true',
      );
    });

    it('accepts a plain Greenhouse board slug', async () => {
      await expect(
        boardUrlFor({ companySlug: 'stratolaunch-labs' }),
      ).resolves.toBe(
        'https://api.greenhouse.io/v1/boards/stratolaunch-labs/jobs?content=true',
      );
    });

    it.each([
      // Would climb out of /boards/ and re-point the request.
      '../../../internal',
      '..%2F..%2Finternal',
      // Would graft a query or fragment onto the API path.
      'board?x=1',
      'board#frag',
      'board/jobs',
      'has space',
    ])('falls back to its own board for the token %p', async (companySlug) => {
      await expect(boardUrlFor({ companySlug })).resolves.toBe(
        'https://api.greenhouse.io/v1/boards/stratolaunch/jobs?content=true',
      );
    });

    it('takes the board from a Greenhouse companyUrl without its query string', async () => {
      await expect(
        boardUrlFor({
          companyUrl: 'https://job-boards.greenhouse.io/acme?utm=1',
        }),
      ).resolves.toBe(
        'https://api.greenhouse.io/v1/boards/acme/jobs?content=true',
      );
    });
  });

  describe('bounded entity decoding', () => {
    it('still fully decodes the double-escaped content Greenhouse serves', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          jobs: [
            {
              id: 1,
              title: 'Engineer',
              // Greenhouse escapes the markup once and the ampersand twice.
              content: '&lt;p&gt;Guidance &amp;amp; Navigation&lt;/p&gt;',
              location: { name: 'Mojave, CA' },
            },
          ],
        },
      });

      const service = new StratolaunchService();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
      } as ScraperInputDto);

      expect(result.jobs[0].description).toContain('Guidance & Navigation');
      expect(result.jobs[0].description).not.toContain('&amp;');
      expect(result.jobs[0].description).not.toContain('<p>');
    });

    it('returns promptly on a deeply nested entity chain instead of decoding to a fixpoint', async () => {
      // Decoding this to a fixpoint is quadratic in the nesting depth: ~5 s of
      // blocked event loop at 60 KB. The pass cap makes it linear.
      const nested = '&' + 'amp;'.repeat(60 * 1024 / 5) + 'lt;';
      mockGet.mockResolvedValueOnce({
        data: {
          jobs: [
            { id: 1, title: 'Engineer', content: nested, location: null },
          ],
        },
      });

      const service = new StratolaunchService();
      const started = Date.now();
      const result = await service.scrape({
        siteType: [Site.STRATOLAUNCH],
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
