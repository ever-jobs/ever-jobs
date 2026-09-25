import { BrowserPool } from '@ever-jobs/common';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { WellfoundAtsService } from '../src/wellfound_ats.service';

const apolloPage = (
  listings: Record<string, unknown>[],
  extras: Record<string, unknown> = {},
  totalPageCount = 50,
) =>
  JSON.stringify({
    props: {
      pageProps: {
        apolloState: {
          data: {
            'Startup:55': {
              __typename: 'Startup',
              id: '55',
              slug: 'chipmotors',
              name: 'Chip Motors',
              'jobListingsConnection({"first":20})': {
                __typename: 'JobListingConnection',
                totalPageCount,
                pageSize: 20,
                edges: [],
              },
            },
            ...Object.fromEntries(
              listings.map((l) => [`JobListing:${(l as any).id}`, l]),
            ),
            ...extras,
          },
        },
      },
    },
  });

const listing = (over: Record<string, unknown> = {}) => ({
  __typename: 'JobListing',
  id: '2931160',
  title: 'Motor Controls Engineer',
  slug: 'motor-controls-engineer',
  primaryRoleParent: 'Engineering',
  primaryRoleTitle: 'Electrical Engineer',
  liveStartAt: 1708314143,
  descriptionSnippet: '<p>Design motor controllers.</p>',
  jobType: 'full_time',
  locationNames: ['Austin, TX'],
  remote: false,
  remoteConfig: { __ref: 'JobListingRemoteConfig:9' },
  compensation: '$120k – $200k',
  startup: { __ref: 'Startup:55' },
  ...over,
});

describe('WellfoundAtsService', () => {
  let service: WellfoundAtsService;
  let page: any;

  function stub(pages: { html: string; nextData: string | null }[], urlCounter?: (u: string) => void) {
    let visit = -1;
    const idx = () => Math.max(0, Math.min(visit, pages.length - 1));
    page = {
      goto: jest.fn().mockImplementation(async (url: string) => {
        visit++;
        urlCounter?.(url);
      }),
      content: jest.fn().mockImplementation(async () => pages[idx()].html),
      evaluate: jest.fn().mockImplementation(async () => pages[idx()].nextData),
      context: jest.fn().mockReturnValue({ close: jest.fn().mockResolvedValue(undefined) }),
      close: jest.fn().mockResolvedValue(undefined),
    } as any;
    jest.spyOn(BrowserPool, 'getPage').mockResolvedValue(page);
  }

  beforeEach(() => {
    service = new WellfoundAtsService();
    (service as any).delay = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bad_input when neither companySlug nor a /company/{slug} url is given', async () => {
    stub([{ html: '<html></html>', nextData: null }]);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('bad_input');
    expect(BrowserPool.getPage).not.toHaveBeenCalled();
  });

  it('resolves the slug from companyUrl and maps JobListing fields', async () => {
    const urls: string[] = [];
    stub(
      [
        {
          html: '<html><title>Chip Motors Jobs</title></html>',
          nextData: apolloPage([listing()], {
            'JobListingRemoteConfig:9': {
              __typename: 'JobListingRemoteConfig',
              id: '9',
              kind: 'remote_ok',
            },
          }),
        },
      ],
      (u) => urls.push(u),
    );

    const res = await service.scrape(
      new ScraperInputDto({ companyUrl: 'https://wellfound.com/company/chipmotors/jobs' }),
    );

    expect(urls[0]).toBe('https://wellfound.com/company/chipmotors/jobs');
    expect(res.jobs).toHaveLength(1);
    const job = res.jobs[0];
    expect(job.id).toBe('wellfound_ats-2931160');
    expect(job.title).toBe('Motor Controls Engineer');
    expect(job.companyName).toBe('Chip Motors');
    expect(job.jobUrl).toBe('https://wellfound.com/jobs/2931160-motor-controls-engineer');
    expect(job.department).toBe('Engineering');
    expect(job.isRemote).toBe(true); // remoteConfig kind remote_ok
    expect(job.compensation?.minAmount).toBe(120000);
    expect(job.compensation?.maxAmount).toBe(200000);
    expect(job.compensation?.currency).toBe('USD');
    expect(job.datePosted).toBe('2024-02-19');
    expect(job.site).toBe(Site.WELLFOUND_ATS);
    expect(job.atsId).toBe('2931160');
  });

  it('resolves the slug from companySlug', async () => {
    const urls: string[] = [];
    stub(
      [{ html: '<html></html>', nextData: apolloPage([listing({ id: '1', remote: true })]) }],
      (u) => urls.push(u),
    );
    const res = await service.scrape(new ScraperInputDto({ companySlug: 'chipmotors' }));
    expect(urls[0]).toBe('https://wellfound.com/company/chipmotors/jobs');
    expect(res.jobs).toHaveLength(1);
  });

  it('paginates via ?page=N while new listings appear, deduping by id', async () => {
    const urls: string[] = [];
    stub(
      [
        { html: '<html></html>', nextData: apolloPage([listing({ id: 'a' }), listing({ id: 'b' })]) },
        { html: '<html></html>', nextData: apolloPage([listing({ id: 'b' }), listing({ id: 'c' })]) },
        { html: '<html></html>', nextData: apolloPage([listing({ id: 'b' }), listing({ id: 'c' })]) },
      ],
      (u) => urls.push(u),
    );

    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'chipmotors', resultsWanted: 999 }),
    );
    expect(urls).toEqual([
      'https://wellfound.com/company/chipmotors/jobs',
      'https://wellfound.com/company/chipmotors/jobs?page=2',
      'https://wellfound.com/company/chipmotors/jobs?page=3',
    ]);
    expect(res.jobs.map((j) => j.atsId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('honors resultsWanted', async () => {
    stub([
      {
        html: '<html></html>',
        nextData: apolloPage([listing({ id: 'a' }), listing({ id: 'b' }), listing({ id: 'c' })]),
      },
    ]);
    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'chipmotors', resultsWanted: 2 }),
    );
    expect(res.jobs).toHaveLength(2);
  });

  it('honors offset (returns the requested window)', async () => {
    stub([
      {
        html: '<html></html>',
        nextData: apolloPage([listing({ id: 'a' }), listing({ id: 'b' }), listing({ id: 'c' })]),
      },
    ]);
    const res = await service.scrape(
      new ScraperInputDto({ companySlug: 'chipmotors', resultsWanted: 1, offset: 1 }),
    );
    expect(res.jobs.map((j) => j.atsId)).toEqual(['b']);
  });

  it('reports blocked when the page is a Cloudflare challenge', async () => {
    stub([
      {
        html: '<html><title>Just a moment...</title>cf-challenge-platform</html>',
        nextData: null,
      },
    ]);
    const res = await service.scrape(new ScraperInputDto({ companySlug: 'chipmotors' }));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('blocked');
  });

  it('reports empty when a real page has no JobListing entries', async () => {
    stub([{ html: '<html></html>', nextData: apolloPage([]) }]);
    const res = await service.scrape(new ScraperInputDto({ companySlug: 'chipmotors' }));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  /**
   * Spec 1689 (fork-sync hardening): the remote-config map is per scrape. Nest
   * providers are singletons, so these reuse ONE service instance.
   */
  describe('remote-config kinds are scoped per scrape', () => {
    const remoteOk = {
      'JobListingRemoteConfig:9': { __typename: 'JobListingRemoteConfig', id: '9', kind: 'remote_ok' },
    };

    it('a later scrape does not see an earlier scrape\'s remote-config entries', async () => {
      // Scrape 1: listing -> RemoteConfig:9 = remote_ok (remote).
      stub([{ html: '<html></html>', nextData: apolloPage([listing({ id: 'first' })], remoteOk) }]);
      const first = await service.scrape(new ScraperInputDto({ companySlug: 'chipmotors' }));
      expect(first.jobs[0].isRemote).toBe(true);

      // Scrape 2 (another board): same ref, but its payload carries no config.
      stub([{ html: '<html></html>', nextData: apolloPage([listing({ id: 'second', locationNames: ['Austin, TX'] })]) }]);
      const second = await service.scrape(new ScraperInputDto({ companySlug: 'othercorp' }));

      expect(second.jobs).toHaveLength(1);
      expect(second.jobs[0].isRemote).toBe(false);
    });

    it('concurrent scrapes on one instance each use only their own remote-config entries', async () => {
      const pageFor = (nextData: string) => ({
        goto: jest.fn().mockResolvedValue(undefined),
        content: jest.fn().mockResolvedValue('<html></html>'),
        evaluate: jest.fn().mockResolvedValue(nextData),
        context: jest.fn().mockReturnValue({ close: jest.fn().mockResolvedValue(undefined) }),
        close: jest.fn().mockResolvedValue(undefined),
      });
      const onsite = {
        'JobListingRemoteConfig:9': { __typename: 'JobListingRemoteConfig', id: '9', kind: 'onsite' },
      };
      jest
        .spyOn(BrowserPool, 'getPage')
        .mockResolvedValueOnce(pageFor(apolloPage([listing({ id: 'r' })], remoteOk)) as any)
        .mockResolvedValueOnce(pageFor(apolloPage([listing({ id: 'o' })], onsite)) as any);

      const [remote, office] = await Promise.all([
        service.scrape(new ScraperInputDto({ companySlug: 'remoteco' })),
        service.scrape(new ScraperInputDto({ companySlug: 'officeco' })),
      ]);

      expect(remote.jobs[0].isRemote).toBe(true);
      expect(office.jobs[0].isRemote).toBe(false);
    });

    it('keeps no remote-config state on the service instance', async () => {
      stub([{ html: '<html></html>', nextData: apolloPage([listing()], remoteOk) }]);
      await service.scrape(new ScraperInputDto({ companySlug: 'chipmotors' }));

      expect(Object.prototype.hasOwnProperty.call(service, 'lastRemoteConfigKind')).toBe(false);
    });
  });
});
