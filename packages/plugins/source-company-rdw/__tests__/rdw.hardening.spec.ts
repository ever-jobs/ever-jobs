import { Test, TestingModule } from '@nestjs/testing';
import { BrowserPool } from '@ever-jobs/common';
import { ScraperInputDto } from '@ever-jobs/models';
import { RdwService } from '../src/rdw.service';
import { isAllowedRdwUrl } from '../src/rdw.constants';

/**
 * Guards for the navigation hardening applied on top of Spec 5091: the caller's
 * `companyUrl` and every href read off a fetched page reach `page.goto`, so
 * both are checked against Redwire's own domain before the browser follows
 * them, and one unreachable detail page no longer discards the whole board.
 */
describe('RdwService — navigation hardening', () => {
  let service: RdwService;

  function card(href: string, title: string, reqId: string): string {
    return `
      <article class="col-12 job-search-results-card-col">
        <h3 class="card-title job-search-results-card-title">
          <a href="${href}">${title}</a>
        </h3>
        <div class="job-component-requisition-identifier"><span>${reqId}</span></div>
        <div class="job-component-location"><span>Marlborough, Massachusetts, United States</span></div>
      </article>`;
  }

  function searchPage(cards: string): string {
    return `<!doctype html><html><body><div aria-label="Jobs search results">${cards}</div>
      <nav aria-label="Pagination">Displaying <b>1 - 2</b> of <b>2</b> in total</nav>
      </body></html>`;
  }

  const DETAIL = '<!doctype html><html><body><main>A role.</main></body></html>';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RdwService],
    }).compile();
    service = module.get<RdwService>(RdwService);

    jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
      goto: jest.fn().mockResolvedValue(undefined),
      content: jest.fn().mockResolvedValue(''),
      close: jest.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isAllowedRdwUrl', () => {
    it.each([
      'https://careers.rdw.com/jobs/search',
      'https://careers.rdw.com/jobs/search?page=2',
      'https://rdw.com/careers/',
      'http://careers.rdw.com/jobs/search',
    ])('accepts %s', (url) => {
      expect(isAllowedRdwUrl(url)).toBe(true);
    });

    it.each([
      // The suffix appears in the path, not the host.
      'https://evil.com/x.rdw.com',
      // The suffix appears in the fragment or as credentials.
      'https://user@evil.com#.rdw.com',
      'https://rdw.com.evil.com/jobs',
      // Non-http schemes never reach a board.
      'file:///etc/passwd',
      'javascript:alert(1)',
      // Link-local metadata, the classic SSRF target.
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:8080/',
      'not-a-url',
      '',
    ])('rejects %s', (url) => {
      expect(isAllowedRdwUrl(url)).toBe(false);
    });
  });

  it('ignores an off-domain companyUrl and reads its own board instead', async () => {
    const fetched: string[] = [];
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      fetched.push(url);
      return searchPage('');
    });

    await service.scrape(
      new ScraperInputDto({ companyUrl: 'http://169.254.169.254/latest/' }),
    );

    expect(fetched).toEqual(['https://careers.rdw.com/jobs/search']);
  });

  it('honours a companyUrl that is on Redwire’s own domain', async () => {
    const fetched: string[] = [];
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      fetched.push(url);
      return searchPage('');
    });

    await service.scrape(
      new ScraperInputDto({
        companyUrl: 'https://careers.rdw.com/jobs/search?team=avionics',
      }),
    );

    expect(fetched).toEqual([
      'https://careers.rdw.com/jobs/search?team=avionics',
    ]);
  });

  it('skips an off-site job link found on the board page', async () => {
    const fetched: string[] = [];
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes('/jobs/search')) {
        return searchPage(
          card('https://evil.example/steal', 'Poisoned Role', '1') +
            card('/jobs/real-role-42', 'Real Role', '42'),
        );
      }
      return DETAIL;
    });

    const result = await service.scrape(new ScraperInputDto({}));

    expect(fetched).not.toContain('https://evil.example/steal');
    expect(result.jobs.map((j) => j.title)).toEqual(['Real Role']);
  });

  it('keeps the jobs it already has when one detail page fails', async () => {
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      if (url.includes('/jobs/search')) {
        return searchPage(
          card('/jobs/good-role-1', 'Good Role', '1') +
            card('/jobs/broken-role-2', 'Broken Role', '2'),
        );
      }
      if (url.includes('broken-role')) {
        throw new Error('net::ERR_CONNECTION_TIMED_OUT');
      }
      return DETAIL;
    });

    const result = await service.scrape(new ScraperInputDto({}));

    expect(result.jobs.map((j) => j.title)).toEqual(['Good Role']);
    // Jobs AND a failure: `JobsService` reports this row as `partial`
    // (Spec 1680), which it cannot do if the plugin reports nothing.
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.detail).toContain(
      '1 of 2 detail requests failed',
    );
  });

  it('reports why the board failed rather than calling it empty', async () => {
    (service as any).fetchHtml = jest.fn(async () => {
      throw new Error('net::ERR_CONNECTION_TIMED_OUT');
    });

    const result = await service.scrape(new ScraperInputDto({}));

    expect(result.jobs).toEqual([]);
    // `empty` would read as "this board has no jobs"; page one never loaded.
    expect(result.diagnostics?.reason).not.toBe('empty');
  });

  it('keeps earlier pages and reports the failure when a later page fails', async () => {
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      if (url.includes('page=2')) {
        throw new Error('net::ERR_CONNECTION_TIMED_OUT');
      }
      if (url.includes('/jobs/search')) {
        // `hasNext` stays true, so the crawl tries page 2.
        return searchPage(card('/jobs/first-1', 'First', '1')).replace(
          'Displaying <b>1 - 2</b> of <b>2</b>',
          'Displaying <b>1 - 1</b> of <b>9</b>',
        );
      }
      return DETAIL;
    });

    const result = await service.scrape(new ScraperInputDto({}));

    expect(result.jobs.map((j) => j.title)).toEqual(['First']);
    expect(result.diagnostics?.detail).toContain('search page 2 failed');
  });

  it('reports `empty` rather than nothing when the board has no postings', async () => {
    (service as any).fetchHtml = jest.fn(async () => searchPage(''));

    const result = await service.scrape(new ScraperInputDto({}));

    expect(result.jobs).toEqual([]);
    expect(result.diagnostics?.reason).toBe('empty');
  });

  it('stops fetching details once resultsWanted is satisfied and no filter is set', async () => {
    const fetched: string[] = [];
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes('/jobs/search')) {
        return searchPage(
          card('/jobs/first-1', 'First', '1') + card('/jobs/second-2', 'Second', '2'),
        );
      }
      return DETAIL;
    });

    const result = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1 }),
    );

    expect(result.jobs).toHaveLength(1);
    expect(fetched.filter((u) => !u.includes('/jobs/search'))).toHaveLength(1);
  });

  it('still walks the whole board when a filter is active', async () => {
    const fetched: string[] = [];
    (service as any).fetchHtml = jest.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes('/jobs/search')) {
        return searchPage(
          card('/jobs/first-1', 'Avionics Engineer', '1') +
            card('/jobs/second-2', 'Structures Engineer', '2'),
        );
      }
      return DETAIL;
    });

    // `applyInput` filters after the crawl, so an early stop here would drop
    // the only matching job.
    const result = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, searchTerm: 'structures' }),
    );

    expect(fetched.filter((u) => !u.includes('/jobs/search'))).toHaveLength(2);
    expect(result.jobs.map((j) => j.title)).toEqual(['Structures Engineer']);
  });
});
