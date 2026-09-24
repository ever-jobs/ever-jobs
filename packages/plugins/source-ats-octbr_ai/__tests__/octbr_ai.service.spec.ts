import 'reflect-metadata';
import { createHttpClient } from '@ever-jobs/common';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { OctbrAiService } from '../src/octbr_ai.service';
import { OCTBR_AI_DETAIL_CONCURRENCY } from '../src/octbr_ai.constants';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn((...args: unknown[]) => actual.createHttpClient(...args)),
  };
});

const LIST_JOB = (over: object = {}) => ({
  id: 712,
  title: 'Electrical Engineer',
  slug: 'electrical-engineer-d9yjKO',
  url: 'https://starcloud.octbr.ai/jobs/electrical-engineer-d9yjKO',
  location: 'Redmond, WA',
  location_type: 'onsite',
  employment_type: 'full_time',
  employment_type_label: 'Full Time',
  posted_date: '1 month ago',
  ...over,
});

const DETAIL_JOB = {
  id: 712,
  title: 'Electrical Engineer',
  description: '<p>Build satellites.</p>',
  responsibilities: '<ul><li>Design boards.</li></ul>',
  requirements: '<ul><li>BS EE.</li></ul>',
  posted_date: 'August 5, 2026',
};

function dataPage(props: object): string {
  const json = JSON.stringify({ component: 'x', props, url: '/', version: '' });
  return `<html><body><div id="app" data-page="${json.replace(/"/g, '&quot;')}"></div></body></html>`;
}

const LISTING = dataPage({
  jobsByDepartment: [
    { department: 'Electrical Engineering', jobs: [LIST_JOB(), LIST_JOB({ id: 716, title: 'Lead Electrical Engineer', slug: 'lead-electrical-engineer-E9Rmhe', url: 'https://starcloud.octbr.ai/jobs/lead-electrical-engineer-E9Rmhe' })] },
    { department: 'Thermal Engineering', jobs: [LIST_JOB({ id: 711, title: 'Lead Thermal Engineer', slug: 'lead-thermal-engineer-eC7zHN', url: 'https://starcloud.octbr.ai/jobs/lead-thermal-engineer-eC7zHN' })] },
  ],
  organisation: { name: 'Starcloud' },
  totalJobs: 3,
});

const DETAIL = dataPage({ job: DETAIL_JOB });

interface Seams {
  fetchText: (client: unknown, url: string) => Promise<string>;
}

function serviceWith(
  fetchImpl: (url: string) => Promise<string>,
): OctbrAiService {
  const service = new OctbrAiService();
  jest
    .spyOn(service as unknown as Seams, 'fetchText')
    .mockImplementation((_c: unknown, url: string) => fetchImpl(url));
  return service;
}

const okListing = (detailHtml: string = DETAIL) => (url: string) =>
  Promise.resolve(url === 'https://starcloud.octbr.ai/' ? LISTING : detailHtml);

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), { companySlug: 'starcloud' }, overrides);
}

describe('OctbrAiService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('enumerates every job across departments', async () => {
    const { jobs } = await serviceWith(okListing()).scrape(inputFrom());
    expect(jobs.map((j) => j.title).sort()).toEqual([
      'Electrical Engineer',
      'Lead Electrical Engineer',
      'Lead Thermal Engineer',
    ]);
  });

  it('maps identity, company name, url, and department', async () => {
    const { jobs } = await serviceWith(okListing()).scrape(inputFrom());
    const job = jobs.find((j) => j.title === 'Lead Thermal Engineer')!;
    expect(job.site).toBe(Site.OCTBR_AI);
    expect(job.id).toBe('octbr_ai-starcloud-711');
    expect(job.companyName).toBe('Starcloud');
    expect(job.jobUrl).toBe('https://starcloud.octbr.ai/jobs/lead-thermal-engineer-eC7zHN');
    expect(job.applyUrl).toBe(job.jobUrl);
    expect(job.department).toBe('Thermal Engineering');
    expect(job.atsType).toBe('octbr_ai');
    expect(job.atsId).toBe('711');
  });

  it('parses location and employment type', async () => {
    const { jobs } = await serviceWith(okListing()).scrape(inputFrom());
    const job = jobs[0];
    expect(job.location?.displayLocation()).toContain('Redmond');
    expect(job.isRemote).toBe(false);
    expect(job.jobType).toEqual([JobType.FULL_TIME]);
  });

  it('fills description and absolute posted date from the detail page', async () => {
    const { jobs } = await serviceWith(okListing()).scrape(inputFrom());
    const job = jobs[0];
    expect(job.description).toContain('Build satellites.');
    expect(job.description).toContain('Design boards.');
    expect(job.description).toContain('BS EE.');
    expect(job.datePosted).toEqual(new Date('August 5, 2026'));
  });

  it('keeps jobs whose detail fetch fails', async () => {
    const service = serviceWith(async (url: string) => {
      if (url === 'https://starcloud.octbr.ai/') return LISTING;
      throw new Error('boom');
    });
    const { jobs } = await service.scrape(inputFrom());
    expect(jobs).toHaveLength(3);
    expect(jobs[0].description ?? null).toBeNull();
  });

  it('returns empty when companySlug is missing', async () => {
    const service = serviceWith(okListing());
    const { jobs } = await service.scrape(
      inputFrom({ companySlug: undefined }),
    );
    expect(jobs).toEqual([]);
  });

  it('returns empty when the listing has no data-page', async () => {
    const service = serviceWith(async () => '<html><body>no jobs</body></html>');
    const { jobs } = await service.scrape(inputFrom());
    expect(jobs).toEqual([]);
  });

  describe('Spec 1689 hardening', () => {
    function listingWith(jobs: object[]): string {
      return dataPage({
        jobsByDepartment: [{ department: 'Eng', jobs }],
        organisation: { name: 'Starcloud' },
      });
    }

    it.each([
      ['10.0.0.1:6443/?x='],
      ['evil.example#'],
      ['x@169.254.169.254/latest/meta-data/?'],
      ['kubernetes.default.svc/version?'],
      ['star.cloud'],
      ['star cloud'],
      ['a'.repeat(64)],
      ['starcloud/../admin'],
    ])('refuses companySlug %p as bad_input without any request', async (slug) => {
      const fetchImpl = jest.fn(okListing());
      const service = serviceWith(fetchImpl);
      const res = await service.scrape(inputFrom({ companySlug: slug }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('accepts a mixed-case hyphenated slug and trims it', async () => {
      const fetchImpl = jest.fn(async () => '<html></html>');
      const service = serviceWith(fetchImpl);
      const res = await service.scrape(inputFrom({ companySlug: ' Star-Cloud-2 ' }));
      expect(res.diagnostics).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledWith('https://Star-Cloud-2.octbr.ai/');
    });

    it('never fetches an off-tenant job.url; rebuilds it from job.slug instead', async () => {
      const fetched: string[] = [];
      const service = serviceWith(async (url: string) => {
        fetched.push(url);
        if (url === 'https://starcloud.octbr.ai/') {
          return listingWith([
            LIST_JOB({ id: 1, slug: 'meta', url: 'http://169.254.169.254/latest/meta-data/' }),
            LIST_JOB({ id: 2, slug: 'k8s', url: 'https://kubernetes.default.svc/api' }),
            LIST_JOB({ id: 3, slug: 'other', url: 'https://othertenant.octbr.ai/jobs/x' }),
            LIST_JOB({ id: 4, slug: 'sub', url: 'https://evil.starcloud.octbr.ai/jobs/x' }),
            LIST_JOB({ id: 5, slug: 'plain', url: 'http://starcloud.octbr.ai/jobs/plain' }),
          ]);
        }
        return DETAIL;
      });
      const { jobs } = await service.scrape(inputFrom());
      expect(fetched.slice(1).sort()).toEqual(
        [
          'https://starcloud.octbr.ai/jobs/k8s',
          'https://starcloud.octbr.ai/jobs/meta',
          'https://starcloud.octbr.ai/jobs/other',
          'https://starcloud.octbr.ai/jobs/plain',
          'https://starcloud.octbr.ai/jobs/sub',
        ].sort(),
      );
      expect(jobs).toHaveLength(5);
      for (const job of jobs) {
        expect(new URL(job.jobUrl!).hostname).toBe('starcloud.octbr.ai');
        expect(job.description).toContain('Build satellites.');
      }
    });

    it('resolves a relative job.url against the tenant origin', async () => {
      const fetched: string[] = [];
      const service = serviceWith(async (url: string) => {
        fetched.push(url);
        return url === 'https://starcloud.octbr.ai/'
          ? listingWith([LIST_JOB({ url: '/jobs/relative-1' })])
          : DETAIL;
      });
      const { jobs } = await service.scrape(inputFrom());
      expect(fetched).toContain('https://starcloud.octbr.ai/jobs/relative-1');
      expect(jobs[0].jobUrl).toBe('https://starcloud.octbr.ai/jobs/relative-1');
    });

    it('skips the detail fetch when job.url is off-tenant and there is no slug', async () => {
      const fetched: string[] = [];
      const service = serviceWith(async (url: string) => {
        fetched.push(url);
        return url === 'https://starcloud.octbr.ai/'
          ? listingWith([LIST_JOB({ slug: '', url: 'https://evil.example/jobs/1' })])
          : DETAIL;
      });
      const { jobs } = await service.scrape(inputFrom());
      expect(fetched).toEqual(['https://starcloud.octbr.ai/']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobUrl).toBe('https://starcloud.octbr.ai/');
      expect(jobs[0].description ?? null).toBeNull();
    });

    it(`fetches details at most ${OCTBR_AI_DETAIL_CONCURRENCY} at a time and keeps order`, async () => {
      const many = Array.from({ length: 13 }, (_, i) =>
        LIST_JOB({
          id: 100 + i,
          title: `Role ${i}`,
          slug: `role-${i}`,
          url: `https://starcloud.octbr.ai/jobs/role-${i}`,
        }),
      );
      let inFlight = 0;
      let peak = 0;
      const service = serviceWith(async (url: string) => {
        if (url === 'https://starcloud.octbr.ai/') return listingWith(many);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const n = Number(url.split('role-')[1]);
        return dataPage({ job: { ...DETAIL_JOB, description: `<p>Detail ${n}</p>` } });
      });
      const { jobs } = await service.scrape(inputFrom());
      expect(peak).toBeLessThanOrEqual(OCTBR_AI_DETAIL_CONCURRENCY);
      expect(peak).toBeGreaterThan(1);
      expect(jobs).toHaveLength(13);
      jobs.forEach((job, i) => {
        expect(job.title).toBe(`Role ${i}`);
        expect(job.description).toContain(`Detail ${i}`);
      });
    });

    it('passes proxies through but never the caller caCert (TLS verification stays on)', async () => {
      (createHttpClient as jest.Mock).mockClear();
      const service = serviceWith(okListing());
      await service.scrape(inputFrom({ caCert: '/etc/ca.pem', proxies: ['http://p:1'] }));
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ proxies: ['http://p:1'], allowedRedirectHosts: ['octbr.ai'] }),
      );
      const options = (createHttpClient as jest.Mock).mock.calls[0][0];
      expect(options).not.toHaveProperty('caCert');
    });
  });
});
