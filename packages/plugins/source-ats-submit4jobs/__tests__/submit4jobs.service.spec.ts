import 'reflect-metadata';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: mockPost,
      setHeaders: jest.fn(),
    })),
  };
});

import { Submit4jobsService } from '../src/submit4jobs.service';

const SLUG = 'ams';

interface Coords {
  apiHost: string;
  template: string;
  cid: string;
}

const MAGNETO: Coords = { apiHost: 'apps.submit4jobs.com', template: 'magneto', cid: '85514' };
const MAGNETOLIVE: Coords = {
  apiHost: 'devapps.pereless.com',
  template: 'magnetolive',
  cid: '85347',
};

/** Board home page embedding the discovery <script src>. */
function board(coords: Coords): string {
  return `<!doctype html><html><head></head><body>
    <script src="//${coords.apiHost}/templates/${coords.template}/embed/iframe.cfm?cid=${coords.cid}"></script>
  </body></html>`;
}

interface JobOpts {
  jid: number;
  title?: string;
  company?: string;
  dname?: string;
  city?: string;
  state?: string;
  fullCountryName?: string;
  jobtype?: string;
  postingdate?: string;
  jobdescription?: string;
  reqsexp?: string;
  salary?: string | number;
  salaryrange?: string | number;
  salarytype?: string | number;
  jobcurrency?: string;
}

function job(o: JobOpts): Record<string, unknown> {
  return {
    jid: o.jid,
    job_title: o.title ?? 'Engineer',
    companyname: o.company ?? '',
    dname: o.dname ?? 'Engineering',
    city: o.city ?? 'Huntsville',
    state: o.state ?? 'AL',
    fullCountryName: o.fullCountryName ?? 'United States',
    country: 'USA',
    jobtype: o.jobtype ?? 'Full-Time/Regular',
    postingdate: o.postingdate ?? 'March, 26 2026 14:27:04',
    jobdescription: o.jobdescription ?? '<p>Build things. Email jobs@ams.test</p>',
    reqsexp: o.reqsexp ?? '',
    salary: o.salary ?? '',
    salaryrange: o.salaryrange ?? '',
    salarytype: o.salarytype ?? 0,
    jobcurrency: o.jobcurrency ?? 'USD',
  };
}

const SET_COOKIE = [
  'CFID=124004779; path=/; HttpOnly',
  'CFTOKEN=d63823e70fa5ce35-719C; path=/; HttpOnly',
  'CFCLIENT_CAREERHOSTING=customf%3D1%23cid%3D85514%23; path=/',
  'CAREEROPS=; expires=Thu, 01-Jan-1970 00:00:00 GMT; path=/',
];

/**
 * Wire the get/post mocks. `list` is the array returned by getJobs (no jid);
 * `details` maps jid -> the enriched job returned when getJobs is called with
 * filters.jid. Board discovery + iframe priming are handled here too.
 */
function serve(opts: {
  coords: Coords;
  boardHtml?: string | null;
  setCookie?: string[] | undefined;
  list: Array<Record<string, unknown>> | string | null;
  details?: Record<number, Record<string, unknown>>;
}): void {
  mockGet.mockImplementation((url: string) => {
    if (/\/embed\/iframe\.cfm/.test(url)) {
      return Promise.resolve({
        data: '',
        headers: { 'set-cookie': opts.setCookie ?? SET_COOKIE },
      });
    }
    // board home page
    if (opts.boardHtml === null) return Promise.reject({ response: { status: 404 } });
    return Promise.resolve({ data: opts.boardHtml ?? board(opts.coords) });
  });

  mockPost.mockImplementation((_url: string, body: string) => {
    const parsed = JSON.parse(body);
    const jid = parsed?.filters?.jid;
    if (jid != null && jid !== '') {
      const detail = opts.details?.[Number(jid)];
      return Promise.resolve({ data: JSON.stringify(detail ? [detail] : []) });
    }
    if (opts.list === null) return Promise.resolve({ data: '<div>error</div>' });
    const data = typeof opts.list === 'string' ? opts.list : JSON.stringify(opts.list);
    return Promise.resolve({ data });
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return { companySlug: SLUG, ...overrides } as ScraperInputDto;
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('Submit4jobsService', () => {
  it('discovers coords, primes a session, and maps a magneto list job', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1, title: 'Radar Engineer', company: 'AMS' })] });
    const res = await new Submit4jobsService().scrape(input());

    expect(res.jobs).toHaveLength(1);
    const j = res.jobs[0];
    expect(j.title).toBe('Radar Engineer');
    expect(j.companyName).toBe('AMS');
    expect(j.site).toBe(Site.SUBMIT4JOBS);
    expect(j.atsId).toBe('1');
    expect(j.atsType).toBe('submit4jobs');
    expect(j.department).toBe('Engineering');
    expect(j.employmentType).toBe('Full-Time/Regular');
    expect(j.jobUrl).toBe('https://ams.submit4jobs.com/#/jobDescription/1/radar-engineer');
    expect(j.location?.city).toBe('Huntsville');
    expect(j.location?.state).toBe('AL');
  });

  it('replays the CF session cookies (not deletion cookies) on getJobs', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1 })] });
    await new Submit4jobsService().scrape(input());

    expect(mockPost).toHaveBeenCalled();
    const cfg = mockPost.mock.calls[0][2];
    const cookie: string = cfg.headers.Cookie;
    expect(cookie).toContain('CFID=124004779');
    expect(cookie).toContain('CFTOKEN=');
    expect(cookie).toContain('CFCLIENT_CAREERHOSTING=');
    expect(cookie).not.toContain('CAREEROPS');
    expect(cfg.headers.cid).toBe('85514');
  });

  it('discovers the magnetolive host/template and fills body via detail fan-out', async () => {
    const listRow = job({ jid: 9, title: 'Electrical Engineer', jobdescription: '', reqsexp: '' });
    serve({
      coords: MAGNETOLIVE,
      list: [listRow],
      details: {
        9: job({ jid: 9, title: 'Electrical Engineer', jobdescription: '<p>Design power systems.</p>' }),
      },
    });
    const res = await new Submit4jobsService().scrape(input({ companySlug: 'kratosdefense' }));

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].description).toContain('Design power systems.');
    // one list call + one detail call
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('does NOT fan out for rows that already carry a body', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1, jobdescription: '<p>Has body</p>' })] });
    await new Submit4jobsService().scrape(input());
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('builds structured location and country from city/state/fullCountryName', async () => {
    serve({
      coords: MAGNETO,
      list: [job({ jid: 1, city: 'Newark', state: 'NJ', fullCountryName: 'United States' })],
    });
    const res = await new Submit4jobsService().scrape(input());
    expect(res.jobs[0].location?.city).toBe('Newark');
    expect(res.jobs[0].location?.state).toBe('NJ');
  });

  it('maps hourly compensation from salarytype H', async () => {
    serve({
      coords: MAGNETO,
      list: [job({ jid: 1, salary: '21.0', salaryrange: '21.0', salarytype: 'H', jobcurrency: 'USD' })],
    });
    const res = await new Submit4jobsService().scrape(input());
    const c = res.jobs[0].compensation;
    expect(c?.minAmount).toBe(21);
    expect(c?.interval).toBe('hourly');
    expect(c?.currency).toBe('USD');
  });

  it('maps yearly compensation from salarytype Y with a min/max range', async () => {
    serve({
      coords: MAGNETO,
      list: [job({ jid: 1, salary: '45,000', salaryrange: '55,000', salarytype: 'Y' })],
    });
    const res = await new Submit4jobsService().scrape(input());
    const c = res.jobs[0].compensation;
    expect(c?.minAmount).toBe(45000);
    expect(c?.maxAmount).toBe(55000);
    expect(c?.interval).toBe('yearly');
  });

  it('leaves compensation null when there is no salary', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1, salary: '', salaryrange: '' })] });
    const res = await new Submit4jobsService().scrape(input());
    expect(res.jobs[0].compensation).toBeNull();
  });

  it('parses the Pereless date format into a YYYY-MM-DD day', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1, postingdate: 'March, 26 2026 14:27:04' })] });
    const res = await new Submit4jobsService().scrape(input());
    expect(String(res.jobs[0].datePosted)).toContain('2026-03-26');
  });

  it('de-dupes jobs by jid', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1 }), job({ jid: 1 }), job({ jid: 2 })] });
    const res = await new Submit4jobsService().scrape(input());
    expect(res.jobs).toHaveLength(2);
  });

  it('respects resultsWanted', async () => {
    serve({
      coords: MAGNETO,
      list: [job({ jid: 1 }), job({ jid: 2 }), job({ jid: 3 })],
    });
    const res = await new Submit4jobsService().scrape(input({ resultsWanted: 2 }));
    expect(res.jobs).toHaveLength(2);
  });

  it('returns [] with no HTTP when neither slug nor url is provided', async () => {
    const res = await new Submit4jobsService().scrape({} as ScraperInputDto);
    expect(res.jobs).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('resolves the slug from a companyUrl', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1 })] });
    const res = await new Submit4jobsService().scrape(
      input({ companySlug: undefined, companyUrl: 'https://ams.submit4jobs.com/#/' }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].id).toBe('submit4jobs-ams-1');
  });

  it('returns [] when getJobs answers with error HTML', async () => {
    serve({ coords: MAGNETO, list: null });
    const res = await new Submit4jobsService().scrape(input());
    expect(res.jobs).toHaveLength(0);
  });

  it('returns [] when the board page is unreachable', async () => {
    serve({ coords: MAGNETO, boardHtml: null, list: [job({ jid: 1 })] });
    const res = await new Submit4jobsService().scrape(input());
    expect(res.jobs).toHaveLength(0);
  });

  it('returns [] when the board page lacks an embed script', async () => {
    serve({ coords: MAGNETO, boardHtml: '<html><body>no embed here</body></html>', list: [job({ jid: 1 })] });
    const res = await new Submit4jobsService().scrape(input());
    expect(res.jobs).toHaveLength(0);
  });

  it('formats the description as markdown / html / plain', async () => {
    const desc = '<p><strong>Role</strong> body</p>';
    serve({ coords: MAGNETO, list: [job({ jid: 1, jobdescription: desc })] });

    const md = await new Submit4jobsService().scrape(input({ descriptionFormat: DescriptionFormat.MARKDOWN }));
    expect(md.jobs[0].description).toContain('**Role**');

    serve({ coords: MAGNETO, list: [job({ jid: 1, jobdescription: desc })] });
    const html = await new Submit4jobsService().scrape(input({ descriptionFormat: DescriptionFormat.HTML }));
    expect(html.jobs[0].description).toBe(desc);

    serve({ coords: MAGNETO, list: [job({ jid: 1, jobdescription: desc })] });
    const plain = await new Submit4jobsService().scrape(input());
    expect(plain.jobs[0].description).toContain('Role body');
    expect(plain.jobs[0].description).not.toContain('<p>');
  });

  it('extracts emails from the description body', async () => {
    serve({
      coords: MAGNETO,
      list: [job({ jid: 1, jobdescription: '<p>Apply: careers@ams.test</p>' })],
    });
    const res = await new Submit4jobsService().scrape(input());
    expect(res.jobs[0].emails).toContain('careers@ams.test');
  });

  it('falls back to a de-slugified company name when companyname is empty', async () => {
    serve({ coords: MAGNETO, list: [job({ jid: 1, company: '' })] });
    const res = await new Submit4jobsService().scrape(input({ companySlug: 'new-community' }));
    expect(res.jobs[0].companyName).toBe('New Community');
  });
});
