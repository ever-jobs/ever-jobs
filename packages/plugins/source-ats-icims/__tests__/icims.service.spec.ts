import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

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

import { IcimsService } from '../src/icims.service';

const HOST = 'careers-acme';

interface CardOpts {
  id: number;
  title?: string;
  location?: string;
  category?: string;
  description?: string;
}

function card(o: CardOpts): string {
  const title = o.title ?? `Engineer ${o.id}`;
  const location = o.location ?? 'US-CA-Santa Cruz';
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `
    <li class="iCIMS_JobCardItem">
      <div class="row">
        <div class="col-xs-6 header left">
          <span class="sr-only field-label">Job Locations</span>
          <span>${location}</span>
        </div>
        <div class="col-xs-12 title">
          <a href="https://${HOST}.icims.com/jobs/${o.id}/${slug}/job?in_iframe=1"
             class="iCIMS_Anchor" title="${o.id} - ${title}">
            <span class="sr-only field-label">Title</span>
            <h3>${title}</h3>
          </a>
        </div>
        ${o.description ? `<div class="col-xs-12 description">${o.description}</div>` : ''}
        <div class="col-xs-12 additionalFields">
          <dl class="iCIMS_JobHeaderGroup">
            ${o.category ? `<div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">Category</dt><dd class="iCIMS_JobHeaderData"><span>${o.category}</span></dd></div>` : ''}
            <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">ID</dt><dd class="iCIMS_JobHeaderData"><span>2026-${o.id}</span></dd></div>
          </dl>
        </div>
      </div>
    </li>`;
}

function boardPage(cards: string[], pageNum: number, totalPages: number, company = 'Acme Corp'): string {
  return `<!doctype html><html><head><title>Job Listings at ${company}</title></head>
    <body>
      <h1 class="iCIMS_Header">Job Listings</h1>
      <ul class="iCIMS_JobsTable">${cards.join('')}</ul>
      <div class="iCIMS_Pager">Page ${pageNum} of ${totalPages}</div>
    </body></html>`;
}

/** Register a multi-page board keyed by the `pr` query param (0-based page). */
function serveBoard(pages: string[][]): void {
  const total = pages.length;
  mockGet.mockImplementation((url: string) => {
    const m = /[?&]pr=(\d+)/.exec(url);
    const pr = m ? parseInt(m[1], 10) : 0;
    const cards = pages[pr] ?? [];
    return Promise.resolve({ data: boardPage(cards, pr + 1, total) });
  });
}

function input(over: Partial<ScraperInputDto> = {}): ScraperInputDto {
  // ScraperInputDto defaults resultsWanted to 15; use a high cap unless overridden.
  return new ScraperInputDto({ companySlug: HOST, resultsWanted: 1000, ...over } as any);
}

describe('IcimsService', () => {
  beforeEach(() => mockGet.mockReset());

  it('parses a single board page into normalised jobs', async () => {
    serveBoard([[card({ id: 5108, title: 'Actuators Design Engineer', category: 'Airframe', description: 'Design flight-critical actuators.' })]]);

    const jobs = (await new IcimsService().scrape(input())).jobs;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'icims-careers-acme-5108',
      title: 'Actuators Design Engineer',
      companyName: 'Acme Corp',
      jobUrl: 'https://careers-acme.icims.com/jobs/5108/actuators-design-engineer/job',
      site: Site.ICIMS,
      atsId: '5108',
      atsType: 'icims',
      department: 'Airframe',
      description: 'Design flight-critical actuators.',
      isRemote: false,
    });
    expect(jobs[0].location).toMatchObject({ city: 'Santa Cruz', state: 'CA', country: 'US' });
    // job URL is stripped of the ?in_iframe=1 query
    expect(jobs[0].jobUrl).not.toContain('in_iframe');
  });

  it('walks pages until a short page and de-dupes repeated ids', async () => {
    const full = Array.from({ length: 20 }, (_, i) => card({ id: 100 + i }));
    const page2 = [card({ id: 100 }), card({ id: 200 }), card({ id: 201 })]; // 100 repeats
    serveBoard([full, page2]);

    const jobs = (await new IcimsService().scrape(input())).jobs;

    // 20 unique on page 1 + 2 new on page 2 (id 100 de-duped)
    expect(jobs).toHaveLength(22);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('stops at the pager total even when every page is full', async () => {
    const pageA = Array.from({ length: 20 }, (_, i) => card({ id: 700 + i }));
    const pageB = Array.from({ length: 20 }, (_, i) => card({ id: 720 + i }));
    serveBoard([pageA, pageB]); // "Page x of 2"
    const jobs = (await new IcimsService().scrape(input())).jobs;
    expect(jobs).toHaveLength(40);
    expect(mockGet).toHaveBeenCalledTimes(2); // did not request a 3rd page
  });

  it('honours resultsWanted as a hard cap', async () => {
    const full = Array.from({ length: 20 }, (_, i) => card({ id: 300 + i }));
    serveBoard([full, full.map((_, i) => card({ id: 400 + i }))]);
    const jobs = (await new IcimsService().scrape(input({ resultsWanted: 5 }))).jobs;
    expect(jobs).toHaveLength(5);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('detects remote from the location cell', async () => {
    serveBoard([[card({ id: 1, location: 'US-Remote' }), card({ id: 2, location: 'US-NC-Winston-Salem' })]]);
    const jobs = (await new IcimsService().scrape(input())).jobs;
    const remote = jobs.find((j) => j.atsId === '1')!;
    const dashed = jobs.find((j) => j.atsId === '2')!;
    expect(remote.isRemote).toBe(true);
    expect(remote.location).toMatchObject({ city: 'Remote' });
    // a hyphenated city name survives the country-state-city split
    expect(dashed.location).toMatchObject({ country: 'US', state: 'NC', city: 'Winston-Salem' });
  });

  it('resolves the subdomain from a full icims companyUrl', async () => {
    serveBoard([[card({ id: 9 })]]);
    await new IcimsService().scrape(
      new ScraperInputDto({ companyUrl: 'https://careers-acme.icims.com/jobs/search' } as any),
    );
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('https://careers-acme.icims.com/jobs/search?'),
      expect.anything(),
    );
    expect(mockGet.mock.calls[0][0]).toContain('in_iframe=1');
  });

  it('returns [] when no addressing input is provided', async () => {
    const jobs = (await new IcimsService().scrape(new ScraperInputDto({} as any))).jobs;
    expect(jobs).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('degrades to [] on an unknown tenant (HTTP 404)', async () => {
    mockGet.mockRejectedValue({ response: { status: 404 } });
    const jobs = (await new IcimsService().scrape(input())).jobs;
    expect(jobs).toEqual([]);
  });

  it('falls back to a title-cased subdomain when the board has no company title', async () => {
    mockGet.mockResolvedValueOnce({
      data: `<html><head><title>Careers</title></head><body><ul>${card({ id: 7 })}</ul></body></html>`,
    });
    const jobs = (await new IcimsService().scrape(input())).jobs;
    expect(jobs[0].companyName).toBe('Acme');
  });
});
