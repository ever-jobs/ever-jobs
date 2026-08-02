import 'reflect-metadata';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { PrismhrService } from '../src/prismhr.service';

const SLUG = 'acme-corp';

interface BoardOpts {
  company?: string;
  titles: Array<{ id: number; title: string }>;
  /** state -> city -> [ids] */
  locations?: Record<string, Record<string, number[]>>;
  /** category -> [ids] */
  categories?: Record<string, number[]>;
  remotePositions?: number[];
}

/** Render a board list page with an embedded JobFiltersContainer react-props. */
function board(o: BoardOpts): string {
  const props = {
    categories: o.categories ?? {},
    locations: o.locations ?? {},
    titles: o.titles,
    remotePositions: o.remotePositions ?? [],
    nonRemotePositions: [],
    showAll: true,
  };
  const escaped = JSON.stringify(props).replace(/"/g, '&quot;');
  const company = o.company ?? 'Acme Corp';
  return `<!doctype html><html><head>
    <title>${company} Career Opportunities</title>
    <meta property="og:title" content="${company}" />
    </head><body>
    <div data-react-class="HiringThing.Components.JobFiltersContainer" data-react-props="${escaped}"></div>
    </body></html>`;
}

interface DetailOpts {
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  org?: string;
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  payFrequency?: string;
  category?: string | null;
  /** Omit the JSON-LD block entirely (only react props present). */
  noLd?: boolean;
  /** Omit the ApplyButtonGroup react props (only JSON-LD present). */
  noReactProps?: boolean;
}

function detail(id: number, o: DetailOpts): string {
  const address: Record<string, string> = {};
  if (o.city) address.addressLocality = o.city;
  if (o.region) address.addressRegion = o.region;
  if (o.country) address.addressCountry = o.country;

  const ld: any = {
    '@context': 'http://schema.org/',
    '@type': 'JobPosting',
    title: o.title ?? 'Role',
    description: o.description ?? '<p>Body</p>',
    datePosted: o.datePosted ?? '2026-06-01T00:00:00Z',
    hiringOrganization: { '@type': 'Organization', name: o.org ?? 'Acme Corp' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', ...address } },
  };
  if (o.employmentType) ld.employmentType = o.employmentType;

  const table: any = {
    id,
    company_name: o.org ?? 'Acme Corp',
    title: o.title ?? 'Role',
    html_description: o.description ?? '<p>Body</p>',
    posted_at: o.datePosted ?? '2026-06-01T00:00:00Z',
    location: o.city ? `${o.city}, ${o.region ?? ''}` : '',
    location_info: {
      country: o.country ?? '',
      city: o.city ?? '',
      state: o.region ?? '',
      zipcode: '',
    },
    category: o.category ?? null,
    remote: o.remote ?? false,
    min_salary: o.minSalary != null ? { amount: o.minSalary, currency: o.currency ?? 'USD' } : {},
    max_salary: o.maxSalary != null ? { amount: o.maxSalary, currency: o.currency ?? 'USD' } : {},
    pay_frequency: o.payFrequency ?? 'hourly',
  };
  const reactProps = JSON.stringify({ jobObj: { table } }).replace(/"/g, '&quot;');

  const ldBlock = o.noLd ? '' : `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
  const propsBlock = o.noReactProps
    ? ''
    : `<div data-react-class="HiringThing.Components.ApplyButtonGroup" data-react-props="${reactProps}"></div>`;

  return `<!doctype html><html><head>${ldBlock}</head><body>${propsBlock}</body></html>`;
}

/** Serve a board plus per-id detail map, routed by URL. */
function serve(boardHtml: string | null, details: Record<number, DetailOpts>): void {
  mockGet.mockImplementation((url: string) => {
    const jobMatch = /\/job\/(\d+)/.exec(url);
    if (jobMatch) {
      const id = Number(jobMatch[1]);
      const opts = details[id];
      if (!opts) return Promise.reject({ response: { status: 404 } });
      return Promise.resolve({ data: detail(id, opts) });
    }
    if (boardHtml == null) return Promise.reject({ response: { status: 404 } });
    return Promise.resolve({ data: boardHtml });
  });
}

function input(over: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({ companySlug: SLUG, resultsWanted: 1000, ...over } as any);
}

describe('PrismhrService', () => {
  beforeEach(() => mockGet.mockReset());

  it('parses the board react-props + detail JSON-LD into normalised jobs', async () => {
    serve(
      board({
        titles: [{ id: 111, title: 'Staff Engineer' }],
        locations: { Texas: { Houston: [111] } },
      }),
      {
        111: {
          title: 'Staff Engineer',
          description: '<p>Build things. Contact jobs@acme.com</p>',
          datePosted: '2026-06-08T13:00:00Z',
          city: 'Houston',
          region: 'TX',
          country: 'US',
          org: 'Acme Corp',
        },
      },
    );

    const jobs = (await new PrismhrService().scrape(input())).jobs;

    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.atsId).toBe('111');
    expect(j.id).toBe('prismhr-acme-corp-111');
    expect(j.title).toBe('Staff Engineer');
    expect(j.site).toBe(Site.PRISMHR);
    expect(j.atsType).toBe('prismhr');
    expect(j.jobUrl).toBe('https://acme-corp.prismhr-hire.com/job/111');
    expect(j.applyUrl).toBe('https://acme-corp.prismhr-hire.com/job/111');
    expect(j.datePosted).toBe('2026-06-08');
    expect(j.location).toEqual(expect.objectContaining({ city: 'Houston', state: 'TX', country: 'US' }));
    expect(j.isRemote).toBe(false);
    expect(j.companyName).toBe('Acme Corp');
  });

  it('enumerates every job from the board titles list', async () => {
    serve(
      board({
        titles: [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
          { id: 3, title: 'C' },
        ],
        locations: { California: { 'San Jose': [1, 2, 3] } },
      }),
      { 1: {}, 2: {}, 3: {} },
    );

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs.map((j) => j.atsId).sort()).toEqual(['1', '2', '3']);
  });

  it('maps location from the board state -> city -> [ids] map when detail lacks it', async () => {
    serve(
      board({
        titles: [{ id: 42, title: 'Role' }],
        locations: { Michigan: { Detroit: [42] } },
      }),
      { 42: { noLd: true, noReactProps: true } },
    );

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].location).toEqual(expect.objectContaining({ city: 'Detroit', state: 'Michigan' }));
  });

  it('derives isRemote from the board remotePositions list', async () => {
    serve(
      board({
        titles: [{ id: 7, title: 'Sales Director' }],
        locations: { Arizona: { Phoenix: [7] } },
        remotePositions: [7],
      }),
      { 7: { city: 'Phoenix', region: 'AZ', country: 'US', remote: false } },
    );

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    // detail react-props remote=false, but the board flags it remote
    expect(jobs[0].isRemote).toBe(true);
  });

  it('derives isRemote from the detail react-props remote flag', async () => {
    serve(board({ titles: [{ id: 8, title: 'Role' }] }), {
      8: { remote: true, city: 'Phoenix', region: 'AZ', country: 'US' },
    });

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].isRemote).toBe(true);
  });

  it('falls back to title text for isRemote when board + detail are silent', async () => {
    serve(board({ titles: [{ id: 9, title: 'Remote Support Lead' }] }), {
      9: { title: 'Remote Support Lead' },
    });

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].isRemote).toBe(true);
  });

  it('maps department from the board categories map', async () => {
    serve(
      board({
        titles: [{ id: 5, title: 'Role' }],
        categories: { 'Regulatory Affairs': [5] },
      }),
      { 5: { category: null } },
    );

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].department).toBe('Regulatory Affairs');
  });

  it('prefers the detail react-props category over the board categories map', async () => {
    serve(
      board({
        titles: [{ id: 6, title: 'Role' }],
        categories: { Engineering: [6] },
      }),
      { 6: { category: 'Platform Engineering' } },
    );

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].department).toBe('Platform Engineering');
  });

  it('maps structured compensation from the react-props salary + pay_frequency', async () => {
    serve(board({ titles: [{ id: 3, title: 'Role' }] }), {
      3: { minSalary: 130000, maxSalary: 160000, currency: 'USD', payFrequency: 'yearly' },
    });

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].compensation).toEqual(
      expect.objectContaining({ minAmount: 130000, maxAmount: 160000, currency: 'USD', interval: 'yearly' }),
    );
  });

  it('maps hourly compensation', async () => {
    serve(board({ titles: [{ id: 4, title: 'Role' }] }), {
      4: { minSalary: 24, maxSalary: 29, currency: 'USD', payFrequency: 'hourly' },
    });

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].compensation).toEqual(
      expect.objectContaining({ minAmount: 24, maxAmount: 29, interval: 'hourly' }),
    );
  });

  it('normalises an "annually" pay_frequency to the yearly interval', async () => {
    serve(board({ titles: [{ id: 5, title: 'Role' }] }), {
      5: { minSalary: 180000, maxSalary: 225000, currency: 'USD', payFrequency: 'annually' },
    });

    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].compensation).toEqual(
      expect.objectContaining({ minAmount: 180000, maxAmount: 225000, interval: 'yearly' }),
    );
  });

  it('leaves compensation null when salary objects are empty', async () => {
    serve(board({ titles: [{ id: 2, title: 'Role' }] }), { 2: {} });
    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].compensation).toBeNull();
  });

  it('de-dupes a job listed twice in the titles array', async () => {
    serve(
      board({
        titles: [
          { id: 50, title: 'Role' },
          { id: 50, title: 'Role (dup)' },
        ],
      }),
      { 50: {} },
    );
    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Role');
  });

  it('honours resultsWanted', async () => {
    serve(
      board({
        titles: [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
          { id: 3, title: 'C' },
        ],
      }),
      { 1: {}, 2: {}, 3: {} },
    );
    const jobs = (await new PrismhrService().scrape(input({ resultsWanted: 2 }))).jobs;
    expect(jobs).toHaveLength(2);
  });

  it('returns [] when the board is unreachable (tenant moved off PrismHR)', async () => {
    serve(null, {});
    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs).toEqual([]);
  });

  it('returns [] when neither companySlug nor companyUrl is provided', async () => {
    const jobs = (await new PrismhrService().scrape(new ScraperInputDto({}))).jobs;
    expect(jobs).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('resolves the tenant slug from a companyUrl', async () => {
    serve(board({ titles: [{ id: 1, title: 'Role' }] }), { 1: {} });
    const jobs = (
      await new PrismhrService().scrape(
        new ScraperInputDto({ companyUrl: 'https://acme-corp.prismhr-hire.com/', resultsWanted: 10 } as any),
      )
    ).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobUrl).toBe('https://acme-corp.prismhr-hire.com/job/1');
  });

  it('formats the description as HTML / Markdown / plain text per descriptionFormat', async () => {
    const details = { 1: { description: '<p>Hello <b>World</b></p>' } };

    serve(board({ titles: [{ id: 1, title: 'Role' }] }), details);
    const html = (await new PrismhrService().scrape(input({ descriptionFormat: DescriptionFormat.HTML }))).jobs[0];
    expect(html.description).toContain('<p>');

    serve(board({ titles: [{ id: 1, title: 'Role' }] }), details);
    const plain = (await new PrismhrService().scrape(input({ descriptionFormat: DescriptionFormat.PLAIN }))).jobs[0];
    expect(plain.description).not.toContain('<p>');
    expect(plain.description).toContain('Hello');
  });

  it('extracts emails from the description body', async () => {
    serve(board({ titles: [{ id: 1, title: 'Role' }] }), {
      1: { description: '<p>Apply to careers@acme.com today.</p>' },
    });
    const jobs = (await new PrismhrService().scrape(input())).jobs;
    expect(jobs[0].emails).toContain('careers@acme.com');
  });

  it('uses the JSON-LD hiringOrganization as companyName, board title as fallback', async () => {
    serve(
      board({
        titles: [
          { id: 1, title: 'Role 1' },
          { id: 2, title: 'Role 2' },
        ],
        company: 'Acme Corp',
      }),
      { 1: { org: 'Acme Corporation, LLC' }, 2: { noLd: true, noReactProps: true } },
    );
    const jobs = (await new PrismhrService().scrape(input())).jobs;
    const byId = Object.fromEntries(jobs.map((j) => [j.atsId, j.companyName]));
    expect(byId['1']).toBe('Acme Corporation, LLC');
    expect(byId['2']).toBe('Acme Corp');
  });

  it('keeps a job with description even when the detail react-props are absent (JSON-LD only)', async () => {
    serve(board({ titles: [{ id: 1, title: 'Role' }] }), {
      1: { noReactProps: true, description: '<p>JSON-LD body</p>', datePosted: '2026-05-01T00:00:00Z' },
    });
    const jobs = (await new PrismhrService().scrape(input({ descriptionFormat: DescriptionFormat.PLAIN }))).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toContain('JSON-LD body');
    expect(jobs[0].datePosted).toBe('2026-05-01');
  });
});
