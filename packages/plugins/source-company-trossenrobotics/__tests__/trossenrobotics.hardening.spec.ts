import { Test, TestingModule } from '@nestjs/testing';
import { BrowserPool } from '@ever-jobs/common';
import { ScraperInputDto } from '@ever-jobs/models';
import { TrossenroboticsService } from '../src/trossenrobotics.service';
import { isAllowedTrossenroboticsUrl } from '../src/trossenrobotics.constants';

/**
 * Guards for the navigation hardening applied on top of Spec 5092.
 *
 * This plugin copies the fetched page into `description` (falling back to the
 * whole `<body>`), so an unchecked `companyUrl` or off-site href would not just
 * point the shared browser somewhere private — it would carry back what it read.
 */
describe('TrossenroboticsService — navigation hardening', () => {
  let service: TrossenroboticsService;

  function card(href: string, title: string): string {
    return `
      <section>
        <h2>${title}</h2>
        <p>Ongoing | Full-time | Remote</p>
        <a aria-label="Learn More and Apply" href="${href}">Learn More and Apply</a>
      </section>`;
  }

  const listPage = (cards: string) =>
    `<!doctype html><html><body><main>${cards}</main></body></html>`;

  const DETAIL =
    '<!doctype html><html><body><main><section><h1>A Role</h1><p>Date: 1/2/2026</p></section></main></body></html>';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrossenroboticsService],
    }).compile();
    service = module.get<TrossenroboticsService>(TrossenroboticsService);

    jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
      goto: jest.fn().mockResolvedValue(undefined),
      content: jest.fn().mockResolvedValue(''),
      close: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isAllowedTrossenroboticsUrl', () => {
    it.each([
      'https://www.trossenrobotics.com/careers',
      'https://trossenrobotics.com/careers/salesperson',
      'http://www.trossenrobotics.com/careers',
    ])('accepts %s', (url) => {
      expect(isAllowedTrossenroboticsUrl(url)).toBe(true);
    });

    it.each([
      'https://evil.com/x.trossenrobotics.com',
      'https://user@evil.com#.trossenrobotics.com',
      'https://trossenrobotics.com.evil.com/careers',
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data/',
      'not-a-url',
      '',
    ])('rejects %s', (url) => {
      expect(isAllowedTrossenroboticsUrl(url)).toBe(false);
    });
  });

  it('ignores an off-domain companyUrl and reads its own careers page instead', async () => {
    const fetched: string[] = [];
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      fetched.push(url);
      return listPage('');
    });

    await service.scrape(
      new ScraperInputDto({ companyUrl: 'http://169.254.169.254/latest/' }),
    );

    expect(fetched).toEqual(['https://www.trossenrobotics.com/careers']);
  });

  it('skips an off-site job link found on the careers page', async () => {
    const fetched: string[] = [];
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      fetched.push(url);
      if (url.endsWith('/careers')) {
        return listPage(
          card('https://evil.example/steal', 'Poisoned Role') +
            card('/careers/real-role', 'Real Role'),
        );
      }
      return DETAIL;
    });

    const result = await service.scrape(new ScraperInputDto({}));

    expect(fetched).not.toContain('https://evil.example/steal');
    expect(result.jobs).toHaveLength(1);
  });

  it('keeps the jobs it already has when one detail page fails', async () => {
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      if (url.endsWith('/careers')) {
        return listPage(
          card('/careers/good-role', 'Good Role') +
            card('/careers/broken-role', 'Broken Role'),
        );
      }
      if (url.includes('broken-role')) {
        throw new Error('net::ERR_CONNECTION_TIMED_OUT');
      }
      return DETAIL;
    });

    const result = await service.scrape(new ScraperInputDto({}));

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].jobUrl).toContain('/careers/good-role');
    // Jobs AND a failure: `JobsService` reports this row as `partial`
    // (Spec 1680), which it cannot do if the plugin reports nothing.
    expect(result.diagnostics?.detail).toContain(
      '1 of 2 detail requests failed',
    );
  });

  it('reports `empty` rather than nothing when the careers page has no postings', async () => {
    (service as any).fetchHtml = jest.fn(async () => listPage(''));

    const result = await service.scrape(new ScraperInputDto({}));

    expect(result.jobs).toEqual([]);
    expect(result.diagnostics?.reason).toBe('empty');
  });
});
