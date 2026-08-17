import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DescriptionFormat,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { BrowserPool } from '@ever-jobs/common';
import { GustoHostedService } from '../src/gusto-hosted.service';
import { GUSTO_HOSTED_READY_TIMEOUT_SECONDS } from '../src/gusto-hosted.constants';

const SLUG = 'material-hybrid-manufacturing-inc-ed3a1ae2-cd0f-4b68-b4bb-e8b4e52a3f73';

/** Access the protected fetch seams without loosening them to `any`. */
interface Seams {
  fetchBoardHtml: (slug: string, input: ScraperInputDto) => Promise<string>;
  fetchPostingHtml: (
    postingSlug: string,
    input: ScraperInputDto,
  ) => Promise<string>;
}

interface BoardRow {
  postingSlug: string;
  title?: string;
  hrefSuffix?: string;
}

/** Build a Gusto-hosted board page with `/postings/{slug}` anchors. */
function board(rows: BoardRow[]): string {
  const links = rows
    .map(
      (r) =>
        `<li><a href="/postings/${r.postingSlug}${r.hrefSuffix ?? ''}">${r.title ?? 'Role'}</a></li>`,
    )
    .join('\n');
  return `<!doctype html><html><head><title>Careers</title></head>
    <body><main><ul class="postings">${links}</ul></main></body></html>`;
}

interface DetailOpts {
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  remote?: boolean;
  city?: string;
  region?: string;
  country?: string;
  minSalary?: string;
  maxSalary?: string;
  currency?: string;
  unitText?: string;
  org?: string;
}

/** Build a posting detail page carrying a schema.org JobPosting JSON-LD block. */
function detail(o: DetailOpts): string {
  const address: Record<string, string> = {};
  if (o.city) address.addressLocality = o.city;
  if (o.region) address.addressRegion = o.region;
  if (o.country) address.addressCountry = o.country;
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: o.title ?? 'Role',
    description: o.description ?? '<p>Body</p>',
    datePosted: o.datePosted ?? '2026-06-01',
    hiringOrganization: o.org ?? 'Material Hybrid Manufacturing Inc',
    jobLocation: [
      { '@type': 'Place', address: { '@type': 'PostalAddress', ...address } },
    ],
  };
  if (o.employmentType) ld.employmentType = o.employmentType;
  if (o.remote) ld.jobLocationType = 'TELECOMMUTE';
  if (o.minSalary || o.maxSalary) {
    ld.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: o.currency ?? 'USD',
      value: {
        '@type': 'QuantitativeValue',
        minValue: o.minSalary ?? '',
        maxValue: o.maxSalary ?? '',
        unitText: o.unitText ?? 'YEAR',
      },
    };
  }
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify(ld)}</script>
    </head><body></body></html>`;
}

/** Wire a service whose fetch seams serve a board + a per-posting detail map. */
function serviceWith(
  boardBySlug: Record<string, string>,
  detailBySlug: Record<string, DetailOpts | string | null>,
): GustoHostedService {
  const service = new GustoHostedService();
  const seams = service as unknown as Seams;
  jest
    .spyOn(seams, 'fetchBoardHtml')
    .mockImplementation(async (slug) => boardBySlug[slug] ?? '<html></html>');
  jest
    .spyOn(seams, 'fetchPostingHtml')
    .mockImplementation(async (postingSlug) => {
      const opts = detailBySlug[postingSlug];
      if (opts === null) return '';
      if (typeof opts === 'string') return opts;
      return detail(opts);
    });
  return service;
}

function input(over: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), {
    companySlug: SLUG,
    resultsWanted: 1000,
    ...over,
  });
}

describe('GustoHostedService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('maps a board posting + detail JSON-LD into a full JobPostDto', async () => {
    const service = serviceWith(
      {
        [SLUG]: board([
          { postingSlug: 'material-staff-battery-engineer-d421d87b', title: 'Staff Battery Engineer' },
        ]),
      },
      {
        'material-staff-battery-engineer-d421d87b': {
          title: 'Staff Battery Applications Engineer',
          description: '<p>Build cells. Reach us at jobs@material.inc</p>',
          datePosted: '2026-06-20T00:00:00Z',
          employmentType: 'FULL_TIME',
          city: 'Miami',
          region: 'FL',
          country: 'US',
          minSalary: '150000',
          maxSalary: '200000',
          org: 'Material Hybrid Manufacturing Inc',
        },
      },
    );

    const res = await service.scrape(input());
    expect(res.jobs).toHaveLength(1);
    const job = res.jobs[0];
    expect(job.site).toBe(Site.GUSTO_HOSTED);
    expect(job.title).toBe('Staff Battery Applications Engineer');
    expect(job.companyName).toBe('Material Hybrid Manufacturing Inc');
    expect(job.jobUrl).toBe(
      'https://jobs.gusto.com/postings/material-staff-battery-engineer-d421d87b',
    );
    expect(job.applyUrl).toBe(job.jobUrl);
    expect(job.id).toBe(
      'gusto-hosted-material-staff-battery-engineer-d421d87b',
    );
    expect(job.atsId).toBe('material-staff-battery-engineer-d421d87b');
    expect(job.atsType).toBe('gusto-hosted');
    expect(job.datePosted).toBe('2026-06-20');
    expect(job.location?.city).toBe('Miami');
    expect(job.location?.state).toBe('FL');
    expect(job.employmentType).toBe('FULL_TIME');
    expect(job.jobType).toEqual(['fulltime']);
    expect(job.compensation?.minAmount).toBe(150000);
    expect(job.compensation?.maxAmount).toBe(200000);
    expect(job.emails).toContain('jobs@material.inc');
  });

  it('consumes the input slug: different slugs yield different boards', async () => {
    const OTHER = 'natura-resources-9f1c2d3e-aaaa-bbbb-cccc-1234567890ab';
    const service = serviceWith(
      {
        [SLUG]: board([{ postingSlug: 'material-role-1', title: 'Material Role' }]),
        [OTHER]: board([{ postingSlug: 'natura-role-1', title: 'Natura Role' }]),
      },
      {
        'material-role-1': { org: 'Material Hybrid Manufacturing Inc', title: 'Material Role' },
        'natura-role-1': { org: 'Natura Resources', title: 'Natura Role' },
      },
    );

    const a = await service.scrape(input({ companySlug: SLUG }));
    const b = await service.scrape(input({ companySlug: OTHER }));

    expect(a.jobs.map((j) => j.jobUrl)).toEqual([
      'https://jobs.gusto.com/postings/material-role-1',
    ]);
    expect(b.jobs.map((j) => j.jobUrl)).toEqual([
      'https://jobs.gusto.com/postings/natura-role-1',
    ]);
    expect(a.jobs[0].companyName).not.toBe(b.jobs[0].companyName);
  });

  it('returns [] for a board with no postings', async () => {
    const service = serviceWith({ [SLUG]: board([]) }, {});
    const res = await service.scrape(input());
    expect(res.jobs).toEqual([]);
  });

  it('returns [] for malformed board HTML', async () => {
    const service = serviceWith({ [SLUG]: '<not really html' }, {});
    const res = await service.scrape(input());
    expect(res.jobs).toEqual([]);
  });

  it('emits a role from board fields when its detail page fails', async () => {
    const service = serviceWith(
      { [SLUG]: board([{ postingSlug: 'material-no-detail', title: 'Board Only Role' }]) },
      { 'material-no-detail': null },
    );
    const res = await service.scrape(input());
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Board Only Role');
    // company falls back to the de-slugified tenant (minus its UUID)
    expect(res.jobs[0].companyName).toBe('Material Hybrid Manufacturing Inc');
    expect(res.jobs[0].description).toBeNull();
  });

  it('de-dupes a posting linked more than once', async () => {
    const service = serviceWith(
      {
        [SLUG]: board([
          { postingSlug: 'dupe-role', title: 'Dupe' },
          { postingSlug: 'dupe-role', title: 'Dupe', hrefSuffix: '/applicants/new' },
        ]),
      },
      { 'dupe-role': { title: 'Dupe' } },
    );
    const res = await service.scrape(input());
    expect(res.jobs).toHaveLength(1);
  });

  it('strips a trailing /applicants/new from posting links', async () => {
    const service = serviceWith(
      { [SLUG]: board([{ postingSlug: 'apply-role', title: 'Apply', hrefSuffix: '/applicants/new' }]) },
      { 'apply-role': { title: 'Apply' } },
    );
    const res = await service.scrape(input());
    expect(res.jobs[0].jobUrl).toBe('https://jobs.gusto.com/postings/apply-role');
    expect(res.jobs[0].atsId).toBe('apply-role');
  });

  it('honours resultsWanted', async () => {
    const service = serviceWith(
      {
        [SLUG]: board([
          { postingSlug: 'r1' },
          { postingSlug: 'r2' },
          { postingSlug: 'r3' },
        ]),
      },
      { r1: {}, r2: {}, r3: {} },
    );
    const res = await service.scrape(input({ resultsWanted: 2 }));
    expect(res.jobs).toHaveLength(2);
  });

  it('detects remote from the title when JSON-LD is silent', async () => {
    const service = serviceWith(
      { [SLUG]: board([{ postingSlug: 'remote-role', title: 'Remote Software Engineer' }]) },
      { 'remote-role': { title: 'Remote Software Engineer' } },
    );
    const res = await service.scrape(input());
    expect(res.jobs[0].isRemote).toBe(true);
    expect(res.jobs[0].location?.city).toBe('Remote');
  });

  it('prefers the JSON-LD hiringOrganization over the derived tenant name', async () => {
    const service = serviceWith(
      { [SLUG]: board([{ postingSlug: 'org-role', title: 'Role' }]) },
      { 'org-role': { org: 'Material, Inc.' } },
    );
    const res = await service.scrape(input());
    expect(res.jobs[0].companyName).toBe('Material, Inc.');
  });

  it('returns [] and issues no fetch when no slug/url is given', async () => {
    const service = serviceWith({}, {});
    const seams = service as unknown as Seams;
    const res = await service.scrape(input({ companySlug: undefined, companyUrl: undefined }));
    expect(res.jobs).toEqual([]);
    expect(seams.fetchBoardHtml).not.toHaveBeenCalled();
  });

  it('resolves the slug from a companyUrl', async () => {
    const service = serviceWith(
      { [SLUG]: board([{ postingSlug: 'url-role', title: 'Role' }]) },
      { 'url-role': { title: 'Role' } },
    );
    const res = await service.scrape(
      input({
        companySlug: undefined,
        companyUrl: `https://jobs.gusto.com/boards/${SLUG}`,
      }),
    );
    expect(res.jobs).toHaveLength(1);
  });

  it('formats the description per descriptionFormat', async () => {
    const html = '<p>Hello <strong>world</strong></p>';
    const make = (format: DescriptionFormat) =>
      serviceWith(
        { [SLUG]: board([{ postingSlug: 'fmt', title: 'Role' }]) },
        { fmt: { description: html } },
      ).scrape(input({ descriptionFormat: format }));

    const asHtml = await make(DescriptionFormat.HTML);
    expect(asHtml.jobs[0].description).toBe(html);

    const asPlain = await make(DescriptionFormat.PLAIN);
    expect(asPlain.jobs[0].description).toContain('Hello');
    expect(asPlain.jobs[0].description).not.toContain('<strong>');
  });

  describe('fixture-based regression tests', () => {
    const fixture = (name: string): string =>
      readFileSync(join(__dirname, 'fixtures', name), 'utf8');

    it('parses the material.inc Gusto board and detail HTML', async () => {
      const materialSlug = 'material-hybrid-manufacturing-inc-ed3a1ae2-cd0f-4b68-b4bb-e8b4e52a3f73';
      const materialDetail = fixture('material-detail.html');
      const service = serviceWith(
        { [materialSlug]: fixture('material-board.html') },
        {
          'material-hybrid-manufacturing-inc-staff-battery-applications-engineer-d421d87b-e050-454b-95b8-395b7ec46c9a': materialDetail,
        },
      );

      const res = await service.scrape(
        input({ companySlug: materialSlug }),
      );

      expect(res.jobs).toHaveLength(3);
      const job = res.jobs.find((j) =>
        j.title.includes('Staff Battery Applications Engineer'),
      )!;
      expect(job.title).toBe('Staff Battery Applications Engineer');
      expect(job.companyName).toBe('Material Hybrid Manufacturing Inc');
      expect(job.location?.city).toBe('Miami');
      expect(job.location?.state).toBe('FL');
      expect(job.employmentType).toBe('Full time');
      expect(job.description).toBeTruthy();
      expect(job.description).toContain('What You');
    });

    /**
     * The company "About <Company>" blurb and the job Description are both
     * `.rich-text-container`, and About comes first. When the Description
     * heading does not match, the fallback must not hand the blurb back as the
     * job's own description.
     */
    it('does not fall back to the company About blurb as the description', async () => {
      const materialSlug = 'material-hybrid-manufacturing-inc-ed3a1ae2-cd0f-4b68-b4bb-e8b4e52a3f73';
      // Relabel the Description heading so the primary heading match misses and
      // the fallback is the branch under test.
      const relabelled = fixture('material-detail.html').replace(
        '>Description<',
        '>Role details<',
      );
      expect(relabelled).not.toContain('>Description<');

      const service = serviceWith(
        { [materialSlug]: fixture('material-board.html') },
        {
          'material-hybrid-manufacturing-inc-staff-battery-applications-engineer-d421d87b-e050-454b-95b8-395b7ec46c9a':
            relabelled,
        },
      );

      const res = await service.scrape(input({ companySlug: materialSlug }));
      const job = res.jobs.find((j) =>
        j.title.includes('Staff Battery Applications Engineer'),
      )!;

      // Positive assertion first: without it the negative one below would also
      // hold for an empty description, and the test would pass vacuously.
      expect(job.description).toContain('What You');
      expect(job.description).not.toContain('rewriting the rules');
    });

    it('parses the naturaresources.com Gusto board and detail HTML', async () => {
      const naturaSlug = 'natura-resources-llc-629e09d9-d8bf-4616-94a7-b744e4a77616';
      const naturaDetail = fixture('natura-detail.html');
      const service = serviceWith(
        { [naturaSlug]: fixture('natura-board.html') },
        {
          'natura-resources-llc-sr-mechnical-engineer-nuclear-5bb2a78d-445e-4c93-aab3-b264a4630a98': naturaDetail,
        },
      );

      const res = await service.scrape(input({ companySlug: naturaSlug }));

      expect(res.jobs).toHaveLength(6);
      const job = res.jobs.find((j) =>
        j.title.includes('Sr. Mechnical Engineer'),
      )!;
      expect(job.title).toBe('Sr. Mechnical Engineer, Nuclear');
      expect(job.companyName).toBe('Natura Resources LLC');
      expect(job.location?.city).toBe('Abilene');
      expect(job.location?.state).toBe('TX');
      expect(job.employmentType).toBe('Full time');
      expect(job.description).toBeTruthy();
      expect(job.description).toContain('Role Authority');
    });
  });

  describe('diagnostics (Spec 5082)', () => {
    it('reports browser_unavailable when the board fetch throws a launch error', async () => {
      const service = new GustoHostedService();
      jest
        .spyOn(service as unknown as Seams, 'fetchBoardHtml')
        .mockRejectedValue(
          new Error(
            "browserType.launchPersistentContext: Executable doesn't exist; run npx playwright install",
          ),
        );
      const res = await service.scrape(input());
      expect(res.jobs).toHaveLength(0);
      expect(res.diagnostics?.reason).toBe('browser_unavailable');
    });

    it('reports blocked when the board serves a bot challenge', async () => {
      const service = serviceWith(
        { [SLUG]: '<html><title>Just a moment...</title><div id="cf-challenge"></div></html>' },
        {},
      );
      const res = await service.scrape(input());
      expect(res.jobs).toHaveLength(0);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('reports empty when the board genuinely has no postings', async () => {
      const service = serviceWith({ [SLUG]: '<html><body><main></main></body></html>' }, {});
      const res = await service.scrape(input());
      expect(res.jobs).toHaveLength(0);
      expect(res.diagnostics?.reason).toBe('empty');
    });

    it('reports bad_input when neither slug nor url is provided', async () => {
      const service = new GustoHostedService();
      const res = await service.scrape(input({ companySlug: undefined }));
      expect(res.diagnostics?.reason).toBe('bad_input');
    });
  });

  describe('detail readiness gate (Spec 5083)', () => {
    /** Access the protected posting fetch without loosening it to `any`. */
    interface PostingSeam {
      fetchPostingHtml: (
        postingSlug: string,
        input: ScraperInputDto,
      ) => Promise<string>;
    }

    it('gates the detail page on `h1` with the bounded readiness timeout, not the absent JSON-LD', async () => {
      // Gusto posting pages carry no `application/ld+json`; waiting for it burned
      // the full navigation timeout on every detail fetch. Assert readiness now
      // waits for `h1` with the short readiness timeout.
      const waitForSelector = jest.fn().mockResolvedValue(null);
      const getPageSpy = jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
        goto: jest.fn().mockResolvedValue(undefined),
        waitForSelector,
        content: jest.fn().mockResolvedValue('<html><body><h1>Role</h1></body></html>'),
        close: jest.fn().mockResolvedValue(undefined),
      } as any);

      const service = new GustoHostedService();
      await (service as unknown as PostingSeam).fetchPostingHtml('some-posting-slug', input());

      expect(waitForSelector).toHaveBeenCalledWith(
        'h1',
        expect.objectContaining({
          timeout: GUSTO_HOSTED_READY_TIMEOUT_SECONDS * 1000,
        }),
      );
      expect(waitForSelector).not.toHaveBeenCalledWith(
        'script[type="application/ld+json"]',
        expect.anything(),
      );

      getPageSpy.mockRestore();
    });
  });
});
