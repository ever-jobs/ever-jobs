import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const jobsJson = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'jobs.json'), 'utf8'),
);

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { ZennoAstronauticsService } from '../src/zennoastronautics.service';

function respondWith(payload: unknown): void {
  getMock.mockResolvedValue({ data: payload });
}

describe('ZennoAstronauticsService', () => {
  let service: ZennoAstronauticsService;

  beforeEach(() => {
    getMock.mockReset();
    service = new ZennoAstronauticsService();
  });

  it('maps all jobs from the Sanity query response', async () => {
    respondWith(jobsJson);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 99 }));
    expect(res.jobs).toHaveLength(3);
    expect(res.diagnostics).toBeUndefined();

    const lead = res.jobs.find((j) => j.atsId === 'capture-lead-defense');
    expect(lead).toBeDefined();
    expect(lead!.id).toBe('zennoastronautics-capture-lead-defense');
    expect(lead!.title).toBe(
      'U.S. Government Capture Lead - Defense Space Systems',
    );
    expect(lead!.site).toBe(Site.ZENNOASTRONAUTICS);
    expect(lead!.atsType).toBe('zennoastronautics');
    expect(lead!.companyName).toBe('Zenno Astronautics');
    expect(lead!.location?.city).toBe('Los Angeles');
    expect(lead!.jobType).toEqual(['fulltime']);
    expect(lead!.employmentType).toBe('Full-time');
  });

  it('requests the Sanity query endpoint with the encoded GROQ', async () => {
    respondWith(jobsJson);
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenCalledTimes(1);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('zsx1k6t6.api.sanity.io');
    expect(url).toContain('query=');
    expect(decodeURIComponent(url)).toContain('_type == "job"');
    expect(decodeURIComponent(url)).toContain('isActive == true');
  });

  it('points jobUrl/jobUrlDirect/applyUrl at the per-role page', async () => {
    respondWith(jobsJson);
    const res = await service.scrape(new ScraperInputDto({}));
    const lead = res.jobs.find((j) => j.atsId === 'capture-lead-defense')!;
    expect(lead.jobUrl).toBe(
      'https://www.zennoastronautics.com/careers/capture-lead-defense',
    );
    expect(lead.jobUrlDirect).toBe(lead.jobUrl);
    expect(lead.applyUrl).toBe(lead.jobUrl);
  });

  it('composes description from portable-text blocks with bullets', async () => {
    respondWith(jobsJson);
    const res = await service.scrape(new ScraperInputDto({}));
    const lead = res.jobs.find((j) => j.atsId === 'capture-lead-defense')!;
    const desc = lead.description!;
    expect(desc.length).toBeGreaterThan(500);
    expect(desc).toContain('About The Company');
    expect(desc).toContain('- ');
    const intern = res.jobs.find((j) => j.atsId === 'intern-positions')!;
    expect(intern.description).toContain('- ');
  });

  it('renders linked spans as text (href)', async () => {
    respondWith({
      result: [
        {
          title: 'Linked Role',
          slug: { current: 'linked-role' },
          location: 'Los Angeles, CA',
          type: 'Full-time',
          text: [
            {
              style: 'normal',
              children: [
                {
                  _key: 'a',
                  _type: 'span',
                  marks: ['b'],
                  text: 'Apply here',
                },
              ],
              markDefs: [{ _key: 'b', _type: 'link', href: 'https://x.test/apply' }],
            },
          ],
        },
      ],
    });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs[0].description).toContain(
      'Apply here (https://x.test/apply)',
    );
  });

  it('emits compensation when populated and omits it when null', async () => {
    respondWith({
      result: [
        {
          title: 'Paid Role',
          slug: { current: 'paid-role' },
          compensation: '$150,000 - $180,000 USD per year',
          type: 'Full-time',
        },
        {
          title: 'Unpaid Role',
          slug: { current: 'unpaid-role' },
          compensation: null,
          type: 'Full-time',
        },
      ],
    });
    const res = await service.scrape(new ScraperInputDto({}));
    const paid = res.jobs.find((j) => j.atsId === 'paid-role')!;
    expect(paid.compensation?.minAmount).toBe(150000);
    expect(paid.compensation?.maxAmount).toBe(180000);
    expect(paid.salarySource).toBe('structured');
    const unpaid = res.jobs.find((j) => j.atsId === 'unpaid-role')!;
    expect(unpaid.compensation).toBeUndefined();
  });

  it('keeps non-type values in employmentType without a jobType', async () => {
    respondWith(jobsJson);
    const res = await service.scrape(new ScraperInputDto({}));
    const open = res.jobs.find((j) => j.atsId === 'general-opportunities')!;
    expect(open.employmentType).toBe('OPEN APPLICATION');
    expect(open.jobType).toBeNull();
  });

  it('returns an empty diagnostic when the result array is empty', async () => {
    respondWith({ result: [] });
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

  it('honors searchTerm, location, resultsWanted, and offset', async () => {
    respondWith(jobsJson);
    const search = await service.scrape(
      new ScraperInputDto({ searchTerm: 'Capture' }),
    );
    expect(search.jobs).toHaveLength(1);
    expect(search.jobs[0].atsId).toBe('capture-lead-defense');

    const loc = await service.scrape(
      new ScraperInputDto({ location: 'auckland' }),
    );
    expect(loc.jobs).toHaveLength(1);
    expect(loc.jobs[0].atsId).toBe('intern-positions');

    const paged = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, offset: 1 }),
    );
    expect(paged.jobs).toHaveLength(1);
  });
});

/** Best of three wall-clock runs, in ms (one run can overshoot on a throttled pod). */
function bestOf3Ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('ZennoAstronauticsService scraped-text regexes stay linear (Spec 1689)', () => {
  type Internals = { renderBlock(block: { children: Array<{ text: string }>; markDefs: [] }): string };
  const render = (text: string) =>
    (new ZennoAstronauticsService() as unknown as Internals).renderBlock({ children: [{ text }], markDefs: [] });

  it('still drops trailing newlines and edge whitespace', () => {
    expect(render('Build rockets\n\n\n')).toBe('Build rockets');
    expect(render('  a\nb \n')).toBe('a\nb');
  });

  it('renders a block with a 20k-char inner newline run in linear time', () => {
    const text = `a${'\n'.repeat(20_000)}b`;
    expect(render(text)).toBe(text);
    expect(bestOf3Ms(() => render(text))).toBeLessThan(50);
  });
});
