import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(
  join(__dirname, 'fixtures', 'careers.html'),
  'utf8',
);

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { GetMaxSpaceService } from '../src/getmaxspace.service';
import { GETMAXSPACE_ALLOWED_HOSTS } from '../src/getmaxspace.constants';

function respondWith(payload: unknown): void {
  getMock.mockResolvedValue({ data: payload });
}

describe('GetMaxSpaceService', () => {
  let service: GetMaxSpaceService;

  beforeEach(() => {
    getMock.mockReset();
    service = new GetMaxSpaceService();
  });

  it('maps all 5 jobs from the careers page', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(5);
    expect(res.diagnostics).toBeUndefined();

    const thermal = res.jobs.find((j) => j.title === 'Thermal, Structural, and Dynamics Engineer');
    expect(thermal).toBeDefined();
    expect(thermal!.id).toBe('getmaxspace-ba0c5e7bc67a7420');
    expect(thermal!.atsId).toBe('ba0c5e7bc67a7420');
    expect(thermal!.site).toBe(Site.GETMAXSPACE);
    expect(thermal!.atsType).toBe('getmaxspace');
    expect(thermal!.companyName).toBe('Max Space');
    expect(thermal!.jobUrl).toBe(
      'https://www.indeed.com/job/thermal-structural-and-dynamics-engineer-ba0c5e7bc67a7420',
    );
    expect(thermal!.department).toBe('Engineering');
    expect(thermal!.employmentType).toBe('Permanent');
    expect(thermal!.location?.city).toBe('Rockledge');
    expect(thermal!.location?.state).toBe('FL');
  });

  it('uses the jk param for viewjob links and decodes &amp;', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    const sales = res.jobs.find((j) => j.title === 'Sales Director');
    expect(sales).toBeDefined();
    expect(sales!.id).toBe('getmaxspace-53b6d1af05a44190');
    expect(sales!.jobUrl).toBe('https://www.indeed.com/viewjob?jk=53b6d1af05a44190&from=shareddesktop_copy');
    expect(sales!.department).toBe('Business Development');
  });

  it('assigns every job to Engineering or Business Development', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    const depts = res.jobs.map((j) => j.department).sort();
    expect(depts).toEqual([
      'Business Development',
      'Engineering',
      'Engineering',
      'Engineering',
      'Engineering',
    ]);
  });

  it('falls back to slug-from-title when the href is not an Indeed id', async () => {
    const html =
      '<a class="career-jobs_cms-link" href="https://example.com/apply">' +
      '<div class="career-jobs_list-title is-1"><div>Odd Role</div></div></a>';
    respondWith(html);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs[0].id).toBe('getmaxspace-odd-role');
    expect(res.jobs[0].jobUrl).toBe('https://example.com/apply');
  });

  it('returns an empty diagnostic when no job items are present', async () => {
    respondWith('<html><body><div class="career-jobs_cms-list-wrapper"></div></body></html>');
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns diagnostics when the fetch fails', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('honors resultsWanted and searchTerm', async () => {
    respondWith(careersHtml);
    const paged = await service.scrape(new ScraperInputDto({ resultsWanted: 2 }));
    expect(paged.jobs).toHaveLength(2);

    const searched = await service.scrape(
      new ScraperInputDto({ resultsWanted: 9999, searchTerm: 'mechanical' }),
    );
    expect(searched.jobs).toHaveLength(1);
    expect(searched.jobs[0].title).toBe('Senior Mechanical Engineer');
  });

  describe('companyUrl pin-or-ignore (Spec 1689)', () => {
    it('accepts an on-domain companyUrl', async () => {
      respondWith(careersHtml);
      await service.scrape(
        new ScraperInputDto({ companyUrl: 'https://getmaxspace.com/careers?utm=1' }),
      );
      expect(getMock).toHaveBeenCalledWith('https://getmaxspace.com/careers?utm=1');
    });

    it.each([
      ['off-domain', 'https://evil.example/careers'],
      ['lookalike', 'https://www.getmaxspace.com.evil.example/careers'],
      ['internal IP', 'http://192.168.1.200:8006/api2/json'],
      ['decimal loopback', 'http://2130706433/'],
      ['metadata host', 'http://metadata.google.internal/computeMetadata/v1/'],
    ])('ignores a %s companyUrl and fetches the default board', async (_label, companyUrl) => {
      respondWith(careersHtml);
      const res = await service.scrape(new ScraperInputDto({ companyUrl, resultsWanted: 9999 }));
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith('https://www.getmaxspace.com/careers');
      expect(res.jobs).toHaveLength(5);
    });
  });
});

describe('GetMaxSpaceService companyUrl hygiene (Spec 1689)', () => {
  afterEach(() => getMock.mockReset());

  it('logs only the host of a refused companyUrl, never its credentials or query', () => {
    const svc = new GetMaxSpaceService();
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
    await new GetMaxSpaceService().scrape(new ScraperInputDto({})).catch(() => undefined);
    expect(createHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRedirectHosts: GETMAXSPACE_ALLOWED_HOSTS }),
    );
  });
});
