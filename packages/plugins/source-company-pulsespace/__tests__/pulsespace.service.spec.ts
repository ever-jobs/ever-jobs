import * as fs from 'fs';
import * as path from 'path';
import { BrowserPool, createHttpClient } from '@ever-jobs/common';
import { Country, JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { PulsespaceService } from '../src/pulsespace.service';
import {
  PULSESPACE_ALLOWED_HOSTS,
  PULSESPACE_DEFAULT_STRATEGY,
  readPulsespaceStrategy,
} from '../src/pulsespace.constants';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// Rendered strategy (Spec 5134): the rendered careers list + one detail page.
const careersFixture = fixture('careers.html');
const detailFixture = fixture('principal-controls-engineering-architect.html');
// Bundle strategy (restored, Spec 1689): the pre-rebuild shell + Vite bundle.
const bundleShellFixture = fixture('careers-bundle-shell.html');
const bundleFixture = fixture('bundle.js');
// Pre-rebuild detail page, rendered through the fallback path.
const avionicsDetailFixture = fixture('principal-avionics-architect.html');

const LIST_URL = 'https://pulsespace.com/careers';

describe('PulsespaceService', () => {
  let service: PulsespaceService;
  let getMock: jest.Mock;
  let getPageSpy: jest.SpyInstance;
  let pageClose: jest.Mock;
  let contextClose: jest.Mock;
  let contextBrowser: jest.Mock;

  beforeEach(() => {
    service = new PulsespaceService();
    getMock = jest.fn().mockRejectedValue(new Error('unexpected HTTP fetch'));
    (createHttpClient as jest.Mock).mockReset().mockReturnValue({ get: getMock });
    pageClose = jest.fn().mockResolvedValue(undefined);
    contextClose = jest.fn().mockResolvedValue(undefined);
    contextBrowser = jest.fn().mockReturnValue({});
    getPageSpy = jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      content: jest.fn().mockResolvedValue(''),
      close: pageClose,
      context: () => ({ browser: contextBrowser, close: contextClose }),
    } as any);
  });

  afterEach(() => {
    delete process.env.PULSESPACE_STRATEGY;
    jest.restoreAllMocks();
  });

  /** Replace the browser read with a URL → HTML map (unknown URLs: detail page). */
  function mockPages(pages: Record<string, string> = { [LIST_URL]: careersFixture }): jest.Mock {
    const fetchHtml = jest.fn(async (url: string) => pages[url] ?? detailFixture);
    (service as any).fetchHtml = fetchHtml;
    return fetchHtml;
  }

  function mockBundleFetches(listUrl: string = LIST_URL): void {
    getMock.mockImplementation((url: string) => {
      if (url === listUrl) return Promise.resolve({ data: bundleShellFixture });
      if (url.includes('/assets/index-')) return Promise.resolve({ data: bundleFixture });
      return Promise.resolve({ data: '' });
    });
  }

  describe('rendered strategy (PULSESPACE_STRATEGY=rendered)', () => {
    beforeEach(() => {
      process.env.PULSESPACE_STRATEGY = 'rendered';
    });

    it('scrapes the rendered careers list and detail page', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ resultsWanted: 999 }),
      );

      expect(response.jobs).toHaveLength(1);
      expect(response.jobs[0].title).toBe(
        'Principal Controls Engineering Architect',
      );
      expect(createHttpClient).not.toHaveBeenCalled();
    });

    it('sets Pulse Space metadata and site', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ resultsWanted: 999 }),
      );

      const job = response.jobs[0];
      expect(job.site).toBe(Site.PULSESPACE);
      expect(job.companyName).toBe('Pulse Space');
      expect(job.companyUrl).toBe('https://pulsespace.com');
      expect(job.jobUrl).toBe(
        'https://pulsespace.com/careers/principal-controls-engineering-architect',
      );
      expect(job.jobUrlDirect).toBe(
        'https://pulsespace.com/careers/principal-controls-engineering-architect',
      );
      expect(job.id).toBe('pulsespace-principal-controls-engineering-architect');
    });

    it('extracts location, employment, and department from the icon badges', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ resultsWanted: 999 }),
      );

      const job = response.jobs[0];
      expect(job.location?.city).toBe('Seattle');
      expect(job.location?.state).toBe('WA');
      expect(job.location?.country).toBe(Country.USA);
      expect(job.location?.displayLocation()).toBe('Seattle, WA, USA');
      expect(job.jobType).toEqual([JobType.FULL_TIME]);
      expect(job.employmentType).toBe('Full time');
      expect(job.isRemote).toBe(false);
      expect(job.workFromHomeType).toBeUndefined();
      expect(job.department).toBe('Engineering / Controls');
    });

    it('extracts the full role description from h2 sections', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ resultsWanted: 999 }),
      );

      const job = response.jobs[0];
      expect(job.description).toContain('About this role');
      expect(job.description).toContain('In this role, you will');
      expect(job.description).toContain('What you bring');
      expect(job.description).toContain('What will set you apart');
      expect(job.description).toContain('Pulse develops laser-based systems');
      expect(job.description).toContain('- Instrument the hardware');
    });

    it('filters by searchTerm', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ searchTerm: 'Controls', resultsWanted: 999 }),
      );
      expect(response.jobs.length).toBeGreaterThan(0);

      const empty = await service.scrape(
        new ScraperInputDto({ searchTerm: 'xyznope', resultsWanted: 999 }),
      );
      expect(empty.jobs).toHaveLength(0);
    });

    it('filters by location', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ location: 'Seattle', resultsWanted: 999 }),
      );

      expect(response.jobs.length).toBeGreaterThan(0);
    });

    it('filters by isRemote', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ isRemote: true, resultsWanted: 999 }),
      );

      expect(response.jobs).toHaveLength(0);
    });

    it('filters by jobType', async () => {
      mockPages();

      const response = await service.scrape(
        new ScraperInputDto({ jobType: JobType.FULL_TIME, resultsWanted: 999 }),
      );

      expect(response.jobs).toHaveLength(1);
    });

    it('returns an empty list when no /careers/<slug> links render', async () => {
      (service as any).fetchHtml = jest.fn(async () =>
        '<html><body><main><h1>Careers</h1></main></body></html>',
      );

      const response = await service.scrape(new ScraperInputDto());

      expect(response.jobs).toHaveLength(0);
    });

    describe('Spec 1689 hardening', () => {
      const listWith = (...hrefs: string[]) =>
        `<main>${hrefs.map((h) => `<a href="${h}">role</a>`).join('')}</main>`;

      it('opens an on-domain companyUrl and reports its origin', async () => {
        const fetchHtml = mockPages({ 'https://www.pulsespace.com/careers': careersFixture });
        const response = await service.scrape(
          new ScraperInputDto({ companyUrl: 'https://www.pulsespace.com/careers' }),
        );
        expect(fetchHtml.mock.calls[0][0]).toBe('https://www.pulsespace.com/careers');
        expect(response.jobs[0].companyUrl).toBe('https://www.pulsespace.com');
        expect(response.jobs[0].jobUrl).toBe(
          'https://www.pulsespace.com/careers/principal-controls-engineering-architect',
        );
      });

      it.each([
        ['off-domain', 'https://evil.example/careers'],
        ['internal IP', 'http://10.0.0.5/careers'],
        ['metadata', 'http://169.254.169.254/latest/meta-data/'],
        ['cluster service', 'http://kubernetes.default.svc/careers'],
        ['non-http scheme', 'file:///etc/passwd'],
      ])('never opens a %s companyUrl in the browser', async (_label, companyUrl) => {
        const fetchHtml = mockPages();
        const response = await service.scrape(new ScraperInputDto({ companyUrl }));
        const opened = fetchHtml.mock.calls.map((call) => call[0] as string);
        expect(opened[0]).toBe(LIST_URL);
        for (const url of opened) {
          expect(new URL(url).hostname).toBe('pulsespace.com');
        }
        expect(response.jobs).toHaveLength(1);
      });

      it('follows same-origin detail links only', async () => {
        const fetchHtml = mockPages({
          [LIST_URL]: listWith(
            '/careers/a',
            'https://evil.example/careers/b',
            'http://169.254.169.254/careers/c',
            'https://pulsespace.com/careers/d',
            'https://www.pulsespace.com/careers/e',
            'http://pulsespace.com/careers/f',
          ),
        });
        await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));
        expect(fetchHtml.mock.calls.map((call) => call[0])).toEqual([
          LIST_URL,
          'https://pulsespace.com/careers/a',
          'https://pulsespace.com/careers/d',
        ]);
      });

      it('stops rendering detail pages once offset + resultsWanted jobs are held', async () => {
        const hrefs = ['/careers/a', '/careers/b', '/careers/c', '/careers/d', '/careers/e'];
        const fetchHtml = mockPages({ [LIST_URL]: listWith(...hrefs) });
        const response = await service.scrape(
          new ScraperInputDto({ offset: 1, resultsWanted: 2 }),
        );
        expect(fetchHtml).toHaveBeenCalledTimes(1 + 3);
        expect(response.jobs.map((j) => j.id)).toEqual(['pulsespace-b', 'pulsespace-c']);
      });

      it('renders every detail page when a filter could drop any of them', async () => {
        const hrefs = ['/careers/a', '/careers/b', '/careers/c', '/careers/d', '/careers/e'];
        const fetchHtml = mockPages({ [LIST_URL]: listWith(...hrefs) });
        await service.scrape(new ScraperInputDto({ searchTerm: 'Controls', resultsWanted: 1 }));
        expect(fetchHtml).toHaveBeenCalledTimes(1 + 5);
      });

      it('closes the page and its own (non-persistent) context', async () => {
        mockPages();
        await service.scrape(new ScraperInputDto({}));
        expect(pageClose).toHaveBeenCalledTimes(1);
        expect(contextClose).toHaveBeenCalledTimes(1);
      });

      it('leaves a shared persistent context open', async () => {
        contextBrowser.mockReturnValue(null);
        mockPages();
        await service.scrape(new ScraperInputDto({}));
        expect(pageClose).toHaveBeenCalledTimes(1);
        expect(contextClose).not.toHaveBeenCalled();
      });

      it('closes the page when a render throws', async () => {
        (service as any).fetchHtml = jest.fn(async () => {
          throw new Error('page.goto: Timeout 30000ms exceeded');
        });
        const response = await service.scrape(new ScraperInputDto({}));
        expect(response.diagnostics?.reason).toBe('timeout');
        expect(pageClose).toHaveBeenCalledTimes(1);
        expect(contextClose).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('bundle strategy (PULSESPACE_STRATEGY=bundle)', () => {
    beforeEach(() => {
      process.env.PULSESPACE_STRATEGY = 'bundle';
    });

    it('returns the open roles from the careers page JS bundle without a browser', async () => {
      mockBundleFetches();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(response.jobs).toHaveLength(5);
      expect(response.jobs[0].title).toBe('Principal Avionics Architect – Satellite Systems');
      expect(getPageSpy).not.toHaveBeenCalled();
    });

    it('sets Pulse Space metadata and site', async () => {
      mockBundleFetches();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      const job = response.jobs[0];
      expect(job.site).toBe(Site.PULSESPACE);
      expect(job.companyName).toBe('Pulse Space');
      expect(job.companyUrl).toBe('https://pulsespace.com');
      expect(job.jobUrl).toBe('https://pulsespace.com/careers/principal-avionics-architect');
      expect(job.jobUrlDirect).toBe('https://pulsespace.com/careers/principal-avionics-architect');
      expect(job.id).toBe('pulsespace-principal-avionics-architect');
    });

    it('extracts location, employment, and department metadata', async () => {
      mockBundleFetches();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      const job = response.jobs[0];
      expect(job.location?.city).toBe('Seattle');
      expect(job.location?.state).toBe('WA');
      expect(job.location?.country).toBe(Country.USA);
      expect(job.location?.displayLocation()).toBe('Seattle, WA, USA');
      expect(job.jobType).toEqual([JobType.FULL_TIME]);
      expect(job.employmentType).toBe('Full time');
      expect(job.isRemote).toBe(false);
      expect(job.workFromHomeType).toBeUndefined();
      expect(job.department).toBe('Engineering / Avionics Systems');
    });

    it('leaves applyUrl blank because no application path is exposed', async () => {
      mockBundleFetches();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(response.jobs[0].applyUrl).toBeUndefined();
    });

    it('extracts the full role description from sections', async () => {
      mockBundleFetches();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      const job = response.jobs[0];
      expect(job.description).toContain('Position Summary');
      expect(job.description).toContain('Key Responsibilities');
      expect(job.description).toContain('Basic Qualifications');
      expect(job.description).toContain('Preferred Qualifications');
      expect(job.description).toContain('Competencies');
    });

    it('filters by searchTerm, location, isRemote and jobType', async () => {
      mockBundleFetches();

      const searched = await service.scrape(
        new ScraperInputDto({ searchTerm: 'Avionics', resultsWanted: 999 }),
      );
      expect(searched.jobs.length).toBeGreaterThan(0);
      const none = await service.scrape(
        new ScraperInputDto({ searchTerm: 'xyznope', resultsWanted: 999 }),
      );
      expect(none.jobs).toHaveLength(0);
      const located = await service.scrape(
        new ScraperInputDto({ location: 'Seattle', resultsWanted: 999 }),
      );
      expect(located.jobs.length).toBeGreaterThan(0);
      const remote = await service.scrape(
        new ScraperInputDto({ isRemote: true, resultsWanted: 999 }),
      );
      expect(remote.jobs).toHaveLength(0);
      const fullTime = await service.scrape(
        new ScraperInputDto({ jobType: JobType.FULL_TIME, resultsWanted: 999 }),
      );
      expect(fullTime.jobs).toHaveLength(5);
    });

    it('applies offset and resultsWanted', async () => {
      mockBundleFetches();

      const response = await service.scrape(
        new ScraperInputDto({ offset: 3, resultsWanted: 1 }),
      );

      expect(response.jobs).toHaveLength(1);
      expect(response.jobs[0].id).toBe('pulsespace-principal-mechanical-architect');
    });

    it('uses an on-domain companyUrl for the initial request and resolves bundle links against it', async () => {
      const customUrl = 'https://www.pulsespace.com/careers';
      mockBundleFetches(customUrl);

      const response = await service.scrape(
        new ScraperInputDto({ companyUrl: customUrl, resultsWanted: 999 }),
      );

      expect(getMock).toHaveBeenCalledWith(customUrl);
      expect(getMock).toHaveBeenCalledWith('https://www.pulsespace.com/assets/index-COHmS8Cs.js');
      expect(response.jobs[0].companyUrl).toBe(customUrl);
      expect(response.jobs[0].jobUrl).toBe(
        'https://www.pulsespace.com/careers/principal-avionics-architect',
      );
    });

    it('ignores an off-domain companyUrl and reads the default board', async () => {
      mockBundleFetches();

      const response = await service.scrape(
        new ScraperInputDto({ companyUrl: 'https://example.com/careers', resultsWanted: 999 }),
      );

      expect(getMock.mock.calls.map((call) => call[0])).toEqual([
        LIST_URL,
        'https://pulsespace.com/assets/index-COHmS8Cs.js',
      ]);
      expect(response.jobs).toHaveLength(5);
      expect(response.jobs[0].companyUrl).toBe('https://pulsespace.com');
    });

    it('does not fetch a bundle script hosted off pulsespace.com', async () => {
      getMock.mockImplementation((url: string) =>
        Promise.resolve({
          data:
            url === LIST_URL
              ? '<html><head><script src="http://10.0.0.5/assets/index-evil.js"></script></head></html>'
              : bundleFixture,
        }),
      );

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(getMock).toHaveBeenCalledTimes(1);
      expect(response.jobs).toHaveLength(0);
    });

    it('returns an empty list when the careers page has no JS bundle', async () => {
      getMock.mockResolvedValueOnce({
        data: '<html><head></head><body><h1>Open Positions</h1></body></html>',
      });

      const response = await service.scrape(new ScraperInputDto());

      expect(response.jobs).toHaveLength(0);
      expect(getPageSpy).not.toHaveBeenCalled();
    });

    it('passes caCert and proxies to createHttpClient', async () => {
      mockBundleFetches();

      await service.scrape(
        new ScraperInputDto({ caCert: '/etc/ca.pem', proxies: ['http://p:1'] }),
      );

      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          caCert: '/etc/ca.pem',
          proxies: ['http://p:1'],
          // Spec 1689 — every redirect hop re-pinned, not just the first URL
          allowedRedirectHosts: PULSESPACE_ALLOWED_HOSTS,
        }),
      );
    });

    it('logs only the host of a refused companyUrl, never its credentials or query', () => {
      const debug = jest
        .spyOn((service as any).logger, 'debug')
        .mockImplementation(() => undefined);
      (service as any).pinnedCompanyUrl(
        new ScraperInputDto({ companyUrl: 'https://user:s3cret@evil.example/x?token=t0k' }),
      );
      const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('evil.example');
      expect(logged).not.toMatch(/s3cret|t0k|user:/);
    });

    it('reports a failed HTTP fetch as a diagnostic', async () => {
      getMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const response = await service.scrape(new ScraperInputDto());

      expect(response.jobs).toHaveLength(0);
      expect(response.diagnostics?.reason).toBe('fetch_error');
      expect(getPageSpy).not.toHaveBeenCalled();
    });
  });

  describe('default strategy', () => {
    it('is rendered (the fork shipped it; the live bundle has no job map)', async () => {
      delete process.env.PULSESPACE_STRATEGY;
      mockBundleFetches();
      const fetchHtml = mockPages();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(PULSESPACE_DEFAULT_STRATEGY).toBe('rendered');
      expect(fetchHtml).toHaveBeenCalled();
      expect(response.jobs).toHaveLength(1);
      // no careers-shell or bundle request over HTTP
      expect(getMock).not.toHaveBeenCalled();
    });

    it('treats an unknown PULSESPACE_STRATEGY as the default', async () => {
      process.env.PULSESPACE_STRATEGY = 'carrier-pigeon';
      const fetchHtml = mockPages();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(fetchHtml).toHaveBeenCalled();
      expect(response.jobs).toHaveLength(1);
      expect(getMock).not.toHaveBeenCalled();
    });
  });

  describe('auto strategy (PULSESPACE_STRATEGY=auto, opt-in)', () => {
    beforeEach(() => {
      process.env.PULSESPACE_STRATEGY = 'auto';
    });

    it('uses the bundle when it yields jobs and never opens a browser', async () => {
      mockBundleFetches();
      const fetchHtml = mockPages();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(response.jobs).toHaveLength(5);
      expect(fetchHtml).not.toHaveBeenCalled();
      expect(getPageSpy).not.toHaveBeenCalled();
    });

    it('falls back to the rendered page when the bundle yields no jobs', async () => {
      getMock.mockResolvedValue({ data: '<html><body>rebuilt site</body></html>' });
      mockPages({
        [LIST_URL]: '<main><a href="/careers/principal-avionics-architect">x</a></main>',
        'https://pulsespace.com/careers/principal-avionics-architect': avionicsDetailFixture,
      });

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(response.jobs).toHaveLength(1);
      expect(response.jobs[0].title).toBe('Principal Avionics Architect – Satellite Systems');
      expect(response.jobs[0].description).toContain('Position Summary');
      expect(getPageSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the rendered page when the bundle fetch fails', async () => {
      getMock.mockRejectedValue(new Error('Request failed with status code 503'));
      mockPages();

      const response = await service.scrape(new ScraperInputDto({ resultsWanted: 999 }));

      expect(response.jobs).toHaveLength(1);
      expect(response.jobs[0].title).toBe('Principal Controls Engineering Architect');
    });

    it('reports the rendered failure when both strategies fail (no browser in the image)', async () => {
      getMock.mockResolvedValue({ data: '<html></html>' });
      getPageSpy.mockRejectedValue(
        new Error("browserType.launchPersistentContext: Executable doesn't exist"),
      );

      const response = await service.scrape(new ScraperInputDto());

      expect(response.jobs).toHaveLength(0);
      expect(response.diagnostics?.reason).toBe('browser_unavailable');
    });

  });

  describe('readPulsespaceStrategy', () => {
    it.each([
      [undefined, 'rendered'],
      ['', 'rendered'],
      ['auto', 'auto'],
      ['AUTO', 'auto'],
      ['rendered', 'rendered'],
      ['dom', 'rendered'],
      ['browser', 'rendered'],
      [' bundle ', 'bundle'],
      ['http', 'bundle'],
      ['nope', null],
      ['constructor', null],
      ['__proto__', null],
    ])('%p -> %p', (value, expected) => {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { PULSESPACE_STRATEGY: value };
      expect(readPulsespaceStrategy(env)).toBe(expected);
    });
  });
});
