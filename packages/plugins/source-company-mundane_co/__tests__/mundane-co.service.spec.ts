import { readFileSync } from 'fs';
import { join } from 'path';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';

const bundleJs = readFileSync(join(__dirname, 'fixtures', 'bundle-slice.js'), 'utf8');
const shellHtml =
  '<!doctype html><html><head><script type="module" src="/assets/index-TEST123.js"></script></head><body><div id="root"></div></body></html>';

const getMock = jest.fn();
const gotoMock = jest.fn();
const evaluateMock = jest.fn();
const getPageMock = jest.fn();
const closeMock = jest.fn();
const pageCloseMock = jest.fn();
const contextCloseMock = jest.fn();
const contextBrowserMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
    BrowserPool: {
      getPage: (...args: unknown[]) => getPageMock(...args),
      close: (...args: unknown[]) => closeMock(...args),
      // The real policy-aware navigation (Spec 1690): it ends in the fake page's `goto`.
      navigate: (...args: unknown[]) => actual.BrowserPool.navigate(...args),
    },
  };
});

import { MundaneCoService } from '../src/mundane-co.service';
import { MUNDANE_ALLOWED_HOSTS } from '../src/mundane-co.constants';

function respondOk(bundle: string = bundleJs): void {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/assets/')) return Promise.resolve({ data: bundle });
    return Promise.resolve({ data: shellHtml });
  });
}

describe('MundaneCoService', () => {
  let service: MundaneCoService;

  beforeEach(() => {
    getMock.mockReset();
    gotoMock.mockReset().mockResolvedValue(undefined);
    evaluateMock.mockReset().mockResolvedValue('Rendered Airtable job description.');
    pageCloseMock.mockReset().mockResolvedValue(undefined);
    contextCloseMock.mockReset().mockResolvedValue(undefined);
    contextBrowserMock.mockReset().mockReturnValue({});
    getPageMock.mockReset().mockResolvedValue({
      goto: gotoMock,
      evaluate: evaluateMock,
      close: pageCloseMock,
      context: () => ({ browser: contextBrowserMock, close: contextCloseMock }),
    });
    closeMock.mockReset().mockResolvedValue(undefined);
    service = new MundaneCoService();
    // The Airtable hydrate wait is real time (2.5 s per form); skip it here.
    jest.spyOn(service as unknown as { delay(ms: number): Promise<void> }, 'delay').mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    delete process.env.MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE;
    jest.restoreAllMocks();
  });

  it('maps all 10 embedded jobs and skips non-apply decoy entries', async () => {
    respondOk();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(10);
    expect(res.diagnostics).toBeUndefined();
    expect(res.jobs.every((j) => j.site === Site.MUNDANE_CO)).toBe(true);
    expect(res.jobs.every((j) => j.atsType === 'mundane_co')).toBe(true);
    expect(res.jobs.every((j) => j.companyName === 'Mundane')).toBe(true);
    expect(res.jobs.some((j) => j.jobUrl?.includes('example.com'))).toBe(false);
  });

  it('derives ids from LinkedIn job id, Airtable form id, or title slug', async () => {
    respondOk();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    const linkedin = res.jobs.find((j) => j.title === 'Robotics Product Manager');
    expect(linkedin!.id).toBe('mundane_co-4389747796');
    expect(linkedin!.jobUrl).toBe('https://www.linkedin.com/jobs/view/4389747796/');

    const airtable = res.jobs.find((j) => j.title === 'VP, Teleportation');
    expect(airtable!.id).toBe('mundane_co-pagSC8TmTu8RYMRfN');
    expect(airtable!.jobUrl).toBe('https://airtable.com/appJtaRURYFPJILxd/pagSC8TmTu8RYMRfN/form');
  });

  it('maps category to department and detects internship jobType', async () => {
    respondOk();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    const research = res.jobs.filter((j) => j.department === 'Research');
    const dev = res.jobs.filter((j) => j.department === 'Development');
    const ops = res.jobs.filter((j) => j.department === 'Operations');
    expect(research).toHaveLength(4);
    expect(dev).toHaveLength(5);
    expect(ops).toHaveLength(1);

    const intern = res.jobs.find((j) => j.title === 'Mechatronics Engineer Intern');
    expect(intern!.jobType).toEqual([JobType.INTERNSHIP]);
    const vp = res.jobs.find((j) => j.title === 'VP, Embodied Systems');
    expect(vp!.jobType).toBeNull();
  });

  it('attaches rendered Airtable descriptions; LinkedIn jobs get none', async () => {
    respondOk();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    const airtableJobs = res.jobs.filter((j) => j.jobUrl?.includes('airtable.com'));
    const linkedinJobs = res.jobs.filter((j) => j.jobUrl?.includes('linkedin.com'));
    expect(airtableJobs).toHaveLength(5);
    expect(linkedinJobs).toHaveLength(5);
    expect(gotoMock).toHaveBeenCalledTimes(5);
    expect(airtableJobs.every((j) => j.description === 'Rendered Airtable job description.')).toBe(
      true,
    );
    expect(linkedinJobs.every((j) => !j.description)).toBe(true);
  });

  it('emits the job without description when an Airtable render fails', async () => {
    respondOk();
    evaluateMock
      .mockResolvedValueOnce('Rendered Airtable job description.')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('Rendered Airtable job description.');
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(10);
    const airtableJobs = res.jobs.filter((j) => j.jobUrl?.includes('airtable.com'));
    expect(airtableJobs.filter((j) => j.description)).toHaveLength(4);
    expect(airtableJobs.filter((j) => !j.description)).toHaveLength(1);
  });

  it('returns an empty diagnostic when the shell has no bundle reference', async () => {
    getMock.mockResolvedValue({ data: '<html><body>no scripts</body></html>' });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns an empty diagnostic when the bundle has no job entries', async () => {
    respondOk('var x = [1,2,3]; function f(){return x;}');
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns diagnostics when the careers fetch fails', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('honors searchTerm, location, offset and resultsWanted', async () => {
    respondOk();
    const res = await service.scrape(
      new ScraperInputDto({ resultsWanted: 9999, searchTerm: 'intern' }),
    );
    expect(res.jobs.length).toBeGreaterThan(0);
    expect(res.jobs.every((j) => /intern/i.test(j.title) || /intern/i.test(j.description ?? ''))).toBe(
      true,
    );

    const sliced = await service.scrape(new ScraperInputDto({ resultsWanted: 3, offset: 2 }));
    expect(sliced.jobs).toHaveLength(3);
  });

  describe('browser lifecycle (Spec 1689)', () => {
    it('never closes the shared BrowserPool from scrape()', async () => {
      respondOk();
      await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      respondOk('var x = 1;');
      await service.scrape(new ScraperInputDto({}));
      getMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await service.scrape(new ScraperInputDto({}));
      expect(closeMock).not.toHaveBeenCalled();
    });

    it('closes the shared BrowserPool on module destroy', async () => {
      await service.onModuleDestroy();
      expect(closeMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the old per-scrape pool shutdown behind MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE', async () => {
      process.env.MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE = 'true';
      respondOk();
      await service.scrape(new ScraperInputDto({}));
      expect(closeMock).toHaveBeenCalledTimes(1);
    });

    it('closes the page and its own context after rendering descriptions', async () => {
      respondOk();
      await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      expect(getPageMock).toHaveBeenCalledTimes(1);
      expect(pageCloseMock).toHaveBeenCalledTimes(1);
      expect(contextCloseMock).toHaveBeenCalledTimes(1);
    });

    it('closes the page even when every render throws', async () => {
      respondOk();
      gotoMock.mockRejectedValue(new Error('net::ERR_TIMED_OUT'));
      const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      expect(res.jobs).toHaveLength(10);
      expect(pageCloseMock).toHaveBeenCalledTimes(1);
      expect(contextCloseMock).toHaveBeenCalledTimes(1);
    });

    it('leaves a shared persistent context open', async () => {
      contextBrowserMock.mockReturnValue(null);
      respondOk();
      await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      expect(pageCloseMock).toHaveBeenCalledTimes(1);
      expect(contextCloseMock).not.toHaveBeenCalled();
    });

    it('opens no browser when there is no Airtable form to render', async () => {
      respondOk(
        '{title:"Engineer",category:"Development",location:"Remote",url:"https://www.linkedin.com/jobs/view/1/"}',
      );
      const res = await service.scrape(new ScraperInputDto({}));
      expect(res.jobs).toHaveLength(1);
      expect(getPageMock).not.toHaveBeenCalled();
    });
  });

  describe('apply-link host checks (Spec 1689)', () => {
    const entry = (title: string, url: string) =>
      `{title:"${title}",category:"Research",location:"Remote",url:"${url}"}`;

    it('drops entries whose apply link only mentions airtable.com/linkedin.com off-host', async () => {
      respondOk(
        [
          entry('Path trick', 'http://10.0.0.5/airtable.com/app/pagEvil1/form'),
          entry('Lookalike', 'https://airtable.com.evil.example/app/pagEvil2/form'),
          entry('Query trick', 'https://evil.example/?next=https://airtable.com/app/pagEvil3'),
          entry('LinkedIn path trick', 'https://evil.example/linkedin.com/jobs/view/1'),
          entry('Userinfo', 'https://airtable.com@169.254.169.254/app/pagEvil4/form'),
          entry('Real', 'https://airtable.com/appX/pagRealForm1/form'),
        ].join(','),
      );
      const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      expect(res.jobs.map((j) => j.title)).toEqual(['Real']);
      expect(gotoMock).toHaveBeenCalledTimes(1);
      expect(gotoMock.mock.calls[0][0]).toBe('https://airtable.com/appX/pagRealForm1/form');
    });

    it('opens an http Airtable form over https', async () => {
      respondOk(entry('Http form', 'http://airtable.com/appX/pagHttpForm/form'));
      const res = await service.scrape(new ScraperInputDto({}));
      expect(res.jobs[0].id).toBe('mundane_co-pagHttpForm');
      expect(gotoMock.mock.calls[0][0]).toBe('https://airtable.com/appX/pagHttpForm/form');
    });
  });

  describe('companyUrl pin-or-ignore (Spec 1689)', () => {
    it('fetches an on-domain companyUrl', async () => {
      respondOk();
      await service.scrape(new ScraperInputDto({ companyUrl: 'https://www.mundane.co/join-us' }));
      expect(getMock.mock.calls[0][0]).toBe('https://www.mundane.co/join-us');
    });

    it.each([
      ['off-domain', 'https://evil.example/join-us'],
      ['lookalike', 'https://mundane.co.evil.example/'],
      ['internal IP', 'http://192.168.1.183:4873/'],
      ['dotless', 'http://minio/'],
    ])('ignores a %s companyUrl and fetches the default page', async (_label, companyUrl) => {
      respondOk();
      const res = await service.scrape(new ScraperInputDto({ companyUrl, resultsWanted: 9999 }));
      expect(getMock.mock.calls[0][0]).toBe('https://mundane.co/join-us');
      expect(res.jobs).toHaveLength(10);
    });
  });
});

describe('MundaneCoService companyUrl hygiene (Spec 1689)', () => {
  afterEach(() => getMock.mockReset());

  it('logs only the host of a refused companyUrl, never its credentials or query', () => {
    const svc = new MundaneCoService();
    const debug = jest
      .spyOn((svc as unknown as { logger: { debug: (m: string) => void } }).logger, 'debug')
      .mockImplementation(() => undefined);
    (svc as unknown as { careersUrl(input: ScraperInputDto): string }).careersUrl(
      new ScraperInputDto({ companyUrl: 'https://user:s3cret@evil.example/x?token=t0k' }),
    );
    const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('evil.example');
    expect(logged).not.toMatch(/s3cret|t0k|user:/);
  });

  it('pins every redirect hop to the plugin allowlist', async () => {
    const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
      createHttpClient: jest.Mock;
    };
    createHttpClient.mockClear();
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await new MundaneCoService().scrape(new ScraperInputDto({})).catch(() => undefined);
    expect(createHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRedirectHosts: MUNDANE_ALLOWED_HOSTS }),
    );
  });
});
