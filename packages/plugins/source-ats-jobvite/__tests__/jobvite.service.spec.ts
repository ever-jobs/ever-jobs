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

import { JobviteService } from '../src/jobvite.service';

const SLUG = 'acme-corp';

interface RowOpts {
  id: string;
  title?: string;
  location?: string;
}

/** A department group: an `<h3 class="h2">` heading + a `table.jv-job-list`. */
function group(department: string, rows: RowOpts[]): string {
  const trs = rows
    .map(
      (r) => `
      <tr>
        <td class="jv-job-list-name">
          <a href="/${SLUG}/job/${r.id}">${r.title ?? `Role ${r.id}`}</a>
        </td>
        <td class="jv-job-list-location">${r.location ?? 'Portland, Oregon'}</td>
      </tr>`,
    )
    .join('');
  return `<h3 class="h2">${department}</h3>
    <table class="jv-job-list"><thead><tr><th>Job</th><th>Loc</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function board(groups: string[], company = 'Acme Corp'): string {
  return `<!doctype html><html><head><title>${company} Careers</title></head>
    <body><article class="jv-page-body">${groups.join('\n')}</article></body></html>`;
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

function detail(o: DetailOpts): string {
  const address: Record<string, string> = {};
  if (o.city) address.addressLocality = o.city;
  if (o.region) address.addressRegion = o.region;
  if (o.country) address.addressCountry = o.country;
  const ld: any = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: o.title ?? 'Role',
    description: o.description ?? '<p>Body</p>',
    datePosted: o.datePosted ?? '2026-06-01',
    hiringOrganization: o.org ?? 'Acme Corp',
    jobLocation: [{ '@type': 'Place', address: { '@type': 'PostalAddress', ...address } }],
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

/** Serve a board plus a per-id detail map, routed by URL. */
function serve(boardHtml: string | null, details: Record<string, DetailOpts>): void {
  mockGet.mockImplementation((url: string) => {
    const jobMatch = /\/job\/([a-zA-Z0-9]+)/.exec(url);
    if (jobMatch) {
      const opts = details[jobMatch[1]];
      if (!opts) return Promise.reject({ response: { status: 404 } });
      return Promise.resolve({ data: detail(opts) });
    }
    if (url.endsWith('/jobs')) {
      if (boardHtml == null) return Promise.reject({ response: { status: 302 } });
      return Promise.resolve({ data: boardHtml });
    }
    return Promise.reject({ response: { status: 404 } });
  });
}

function input(over: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({ companySlug: SLUG, resultsWanted: 1000, ...over } as any);
}

describe('JobviteService', () => {
  beforeEach(() => mockGet.mockReset());

  it('parses grouped board + detail JSON-LD into normalised jobs', async () => {
    serve(
      board([
        group('Engineering', [{ id: 'aaa111', title: 'Staff Engineer', location: 'Houston, TX' }]),
      ]),
      {
        aaa111: {
          title: 'Staff Engineer',
          description: '<p>Build things. Contact jobs@acme.com</p>',
          datePosted: '2026-06-08',
          employmentType: 'Full-Time',
          city: 'Houston',
          region: 'TX',
          country: 'United States',
        },
      },
    );

    const jobs = (await new JobviteService().scrape(input())).jobs;

    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.atsId).toBe('aaa111');
    expect(j.id).toBe('jobvite-acme-corp-aaa111');
    expect(j.title).toBe('Staff Engineer');
    expect(j.site).toBe(Site.JOBVITE);
    expect(j.atsType).toBe('jobvite');
    expect(j.department).toBe('Engineering');
    expect(j.employmentType).toBe('Full-Time');
    expect(j.jobUrl).toBe('https://jobs.jobvite.com/acme-corp/job/aaa111');
    expect(j.applyUrl).toBe('https://jobs.jobvite.com/acme-corp/job/aaa111');
    expect(j.datePosted).toBe('2026-06-08');
    expect(j.location).toEqual(expect.objectContaining({ city: 'Houston', state: 'TX', country: 'United States' }));
    expect(j.isRemote).toBe(false);
    expect(j.companyName).toBe('Acme Corp');
  });

  it('assigns department from the nearest preceding heading', async () => {
    serve(
      board([
        group('Engineering', [{ id: 'e1' }, { id: 'e2' }]),
        group('Finance', [{ id: 'f1' }]),
      ]),
      { e1: {}, e2: {}, f1: {} },
    );

    const jobs = (await new JobviteService().scrape(input())).jobs;
    const byId = Object.fromEntries(jobs.map((j) => [j.atsId, j.department]));
    expect(byId).toEqual({ e1: 'Engineering', e2: 'Engineering', f1: 'Finance' });
  });

  it('derives isRemote from the JSON-LD TELECOMMUTE flag', async () => {
    serve(board([group('Ops', [{ id: 'r1', location: 'Remote, United States' }])]), {
      r1: { remote: true, country: 'United States' },
    });

    const jobs = (await new JobviteService().scrape(input())).jobs;
    expect(jobs[0].isRemote).toBe(true);
    expect(jobs[0].location).toEqual(expect.objectContaining({ country: 'United States' }));
  });

  it('falls back to location/title text for isRemote when detail is missing', async () => {
    serve(board([group('Ops', [{ id: 'r2', title: 'Remote Support Lead', location: 'Anywhere' }])]), {});

    const jobs = (await new JobviteService().scrape(input())).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].isRemote).toBe(true);
  });

  it('maps structured compensation from baseSalary', async () => {
    serve(board([group('Eng', [{ id: 'c1' }])]), {
      c1: { minSalary: '130000', maxSalary: '160000', currency: 'USD', unitText: 'YEAR' },
    });

    const jobs = (await new JobviteService().scrape(input())).jobs;
    expect(jobs[0].compensation).toEqual(
      expect.objectContaining({ minAmount: 130000, maxAmount: 160000, currency: 'USD' }),
    );
  });

  it('leaves compensation null when baseSalary is absent/empty', async () => {
    serve(board([group('Eng', [{ id: 'c2' }])]), { c2: {} });
    const jobs = (await new JobviteService().scrape(input())).jobs;
    expect(jobs[0].compensation).toBeNull();
  });

  it('de-dupes a job listed under two departments', async () => {
    serve(
      board([
        group('Engineering', [{ id: 'dup' }]),
        group('Featured', [{ id: 'dup' }]),
      ]),
      { dup: {} },
    );
    const jobs = (await new JobviteService().scrape(input())).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].department).toBe('Engineering');
  });

  it('honours resultsWanted', async () => {
    serve(board([group('Eng', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])]), { a: {}, b: {}, c: {} });
    const jobs = (await new JobviteService().scrape(input({ resultsWanted: 2 }))).jobs;
    expect(jobs).toHaveLength(2);
  });

  it('returns [] when the board redirects away (tenant moved off Jobvite)', async () => {
    serve(null, {});
    const jobs = (await new JobviteService().scrape(input())).jobs;
    expect(jobs).toEqual([]);
  });

  it('returns [] when neither companySlug nor companyUrl is provided', async () => {
    const jobs = (await new JobviteService().scrape(new ScraperInputDto({}))).jobs;
    expect(jobs).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('resolves the tenant slug from a companyUrl', async () => {
    serve(board([group('Eng', [{ id: 'u1' }])]), { u1: {} });
    const jobs = (
      await new JobviteService().scrape(
        new ScraperInputDto({ companyUrl: 'https://jobs.jobvite.com/acme-corp/search?nl=1', resultsWanted: 10 } as any),
      )
    ).jobs;
    expect(jobs).toHaveLength(1);
  });

  it('formats the description as HTML / Markdown / plain text per descriptionFormat', async () => {
    const details = { d1: { description: '<p>Hello <b>World</b></p>' } };

    serve(board([group('Eng', [{ id: 'd1' }])]), details);
    const html = (await new JobviteService().scrape(input({ descriptionFormat: DescriptionFormat.HTML }))).jobs[0];
    expect(html.description).toContain('<p>');

    serve(board([group('Eng', [{ id: 'd1' }])]), details);
    const plain = (await new JobviteService().scrape(input({ descriptionFormat: DescriptionFormat.PLAIN }))).jobs[0];
    expect(plain.description).not.toContain('<p>');
    expect(plain.description).toContain('Hello');
  });

  it('extracts emails from the description body', async () => {
    serve(board([group('Eng', [{ id: 'm1' }])]), {
      m1: { description: '<p>Apply to careers@acme.com today.</p>' },
    });
    const jobs = (await new JobviteService().scrape(input())).jobs;
    expect(jobs[0].emails).toContain('careers@acme.com');
  });

  it('uses the JSON-LD hiringOrganization as companyName, board title as fallback', async () => {
    serve(
      board([group('Eng', [{ id: 'o1' }, { id: 'o2' }])], 'Acme Corp'),
      { o1: { org: 'Acme Corporation, LLC' } },
    );
    const jobs = (await new JobviteService().scrape(input())).jobs;
    const byId = Object.fromEntries(jobs.map((j) => [j.atsId, j.companyName]));
    expect(byId.o1).toBe('Acme Corporation, LLC');
    expect(byId.o2).toBe('Acme Corp');
  });
});
