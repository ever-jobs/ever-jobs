import 'reflect-metadata';
import { DescriptionFormat, JobType, ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: mockSetHeaders,
    })),
  };
});

import { JazzHRService } from '../src/jazzhr.service';

const ORG_LD =
  '<script type="application/ld+json">' +
  JSON.stringify({ '@type': 'Organization', name: 'Opulo, Inc', url: 'https://opulo.io' }) +
  '</script>';

/**
 * A board row, rendered twice: once in the desktop #jobs_table (with a location
 * cell) and once in a mobile block. Only the table copy should be counted.
 */
function boardRow(code: string, title: string, location: string, dept?: string): string {
  const inlineDept = dept
    ? `<br /><span class="resumator_department">${dept}</span>`
    : '';
  return (
    `<tr class="resumator_even_row"><td>` +
    `<a class="job_title_link" href="/apply/jobs/details/${code}?&">${title}</a>${inlineDept}` +
    `</td><td>${location}</td></tr>` +
    `<div class="jobs_row"><a class="job_title_link" href="/apply/jobs/details/${code}?&">${title}</a></div>`
  );
}

function boardHtml(rows: string): string {
  return `<!doctype html><html><head>${ORG_LD}</head><body>` +
    `<table id="jobs_table" class="menu_table"><tbody>${rows}</tbody></table>` +
    `</body></html>`;
}

function detailHtml(opts: {
  company?: string;
  meta?: string;
  description?: string;
}): string {
  return (
    `<html><body>` +
    (opts.company ? `<h2 class="job_company">${opts.company}</h2>` : '') +
    (opts.meta ? `<h3 class="job_meta">${opts.meta}</h3>` : '') +
    `<div id="job_description_wrapper"><div class="job_description">` +
    `${opts.description ?? '<p>Body</p>'}` +
    `</div></div></body></html>`
  );
}

function mockBoard(board: string, detailByCode: Record<string, string>) {
  mockGet.mockImplementation((url: string) => {
    const match = url.match(/\/details\/([^/?#]+)/);
    if (match) {
      const html = detailByCode[match[1]];
      return html != null
        ? Promise.resolve({ data: html })
        : Promise.reject(new Error('404'));
    }
    return Promise.resolve({ data: board });
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    companySlug: 'opulo',
    siteType: [Site.JAZZHR],
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

describe('JazzHRService (board scraping)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
  });

  it('returns one job per role despite the duplicate mobile anchor', async () => {
    mockBoard(boardHtml(boardRow('AAA', 'Firmware Engineer', 'Pittsburgh, PA', 'Engineering')), {
      AAA: detailHtml({ meta: 'Engineering - Pittsburgh, PA - Full Time' }),
    });

    const result = await new JazzHRService().scrape(input());

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].atsId).toBe('AAA');
  });

  it('uses the Organization display name, not the slug', async () => {
    mockBoard(boardHtml(boardRow('AAA', 'Firmware Engineer', 'Pittsburgh, PA')), {
      AAA: detailHtml({ company: 'Opulo, Inc' }),
    });

    const result = await new JazzHRService().scrape(input());

    expect(result.jobs[0].companyName).toBe('Opulo, Inc');
  });

  it('overlays the detail page body, employment type, and department', async () => {
    mockBoard(boardHtml(boardRow('AAA', 'Buyer', 'San Diego, CA', 'Accounting and Finance')), {
      AAA: detailHtml({
        meta: 'Accounting and Finance - San Diego, CA - Full Time',
        description: '<h2>About</h2><p>Run the books.</p>',
      }),
    });

    const result = await new JazzHRService().scrape(input());
    const job = result.jobs[0];

    expect(job.description).toContain('About');
    expect(job.description).toContain('Run the books.');
    expect(job.description).not.toContain('<h2>');
    expect(job.employmentType).toBe('Full Time');
    expect(job.jobType).toContain(JobType.FULL_TIME);
    expect(job.department).toBe('Accounting and Finance');
    expect(job.location?.city).toBe('San Diego');
    expect(job.jobUrl).toBe('https://opulo.applytojob.com/apply/jobs/details/AAA');
  });

  it('reads the department from a section heading row', async () => {
    const rows =
      '<tr class="resumator_department_heading"><td colspan="3">Engineering</td></tr>' +
      boardRow('AAA', 'Firmware Engineer', 'Pittsburgh, PA');
    mockBoard(boardHtml(rows), { AAA: detailHtml({}) });

    const result = await new JazzHRService().scrape(input());

    expect(result.jobs[0].department).toBe('Engineering');
  });

  it('flags remote when the location mentions remote', async () => {
    mockBoard(boardHtml(boardRow('AAA', 'Marketing Lead', 'Remote')), {
      AAA: detailHtml({}),
    });

    const result = await new JazzHRService().scrape(input());

    expect(result.jobs[0].isRemote).toBe(true);
  });

  it('survives a failed detail fetch (still maps board fields)', async () => {
    mockBoard(boardHtml(boardRow('AAA', 'Firmware Engineer', 'Pittsburgh, PA', 'Engineering')), {});

    const result = await new JazzHRService().scrape(input());
    const job = result.jobs[0];

    expect(job.title).toBe('Firmware Engineer');
    expect(job.companyName).toBe('Opulo, Inc');
    expect(job.department).toBe('Engineering');
    expect(job.description).toBeNull();
  });

  it('honors descriptionFormat=html and =plain', async () => {
    mockBoard(boardHtml(boardRow('AAA', 'Engineer', 'Austin, TX')), {
      AAA: detailHtml({ description: '<p>Hello <b>world</b></p>' }),
    });
    const htmlRes = await new JazzHRService().scrape(
      input({ descriptionFormat: DescriptionFormat.HTML }),
    );
    expect(htmlRes.jobs[0].description).toBe('<p>Hello <b>world</b></p>');

    mockBoard(boardHtml(boardRow('AAA', 'Engineer', 'Austin, TX')), {
      AAA: detailHtml({ description: '<p>Hello <b>world</b></p>' }),
    });
    const plainRes = await new JazzHRService().scrape(
      input({ descriptionFormat: DescriptionFormat.PLAIN }),
    );
    expect(plainRes.jobs[0].description).toContain('Hello world');
    expect(plainRes.jobs[0].description).not.toContain('<b>');
  });

  it('returns empty when no companySlug is provided', async () => {
    const result = await new JazzHRService().scrape(input({ companySlug: undefined }));
    expect(result.jobs).toHaveLength(0);
  });
});

describe('JazzHRService (authenticated API)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
  });

  it('maps the resumator REST payload when an API key is set', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        {
          id: 'job9',
          title: 'Backend Engineer',
          city: 'Remote',
          state: null,
          department: 'Engineering',
          type: 'Full Time',
          original_open_date: '2026-06-01',
          board_code: 'bc9',
          description: '<p>Build APIs.</p>',
        },
      ],
    });

    const result = await new JazzHRService().scrape(
      input({ auth: { jazzhr: { apiKey: 'k' } } } as Partial<ScraperInputDto>),
    );

    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0];
    expect(job.title).toBe('Backend Engineer');
    expect(job.datePosted).toBe('2026-06-01');
    expect(job.jobUrl).toBe('https://opulo.applytojob.com/apply/jobs/details/bc9');
    expect(job.department).toBe('Engineering');
  });
});
