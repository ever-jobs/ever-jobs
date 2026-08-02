import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet })),
  };
});

import { NanonuclearenergyService } from '../src/nanonuclearenergy.service';

/**
 * A Divi "role" block mirroring the real NANO markup: a title blurb (h4 +
 * optional subtitle), a body text module, then Full Time / Location / Salary
 * meta blurbs. `salary` is passed raw so tests can exercise the Word-paste
 * artifacts seen live.
 */
function role(opts: {
  title: string;
  subtitle?: string;
  body: string;
  location: string;
  salary: string;
}): string {
  const subtitle = opts.subtitle
    ? `<div class="et_pb_blurb_description"><p><strong>${opts.subtitle}</strong></p></div>`
    : '';
  return `
  <div class="et_pb_module et_pb_blurb et_pb_blurb_0">
    <div class="et_pb_blurb_content"><div class="et_pb_blurb_container">
      <h4 class="et_pb_module_header"><span>${opts.title}</span></h4>
      ${subtitle}
    </div></div>
  </div>
  <div class="et_pb_module et_pb_text et_pb_text_2">
    <div class="et_pb_text_inner"><p>${opts.body}</p></div>
  </div>
  <div class="et_pb_module et_pb_blurb et_pb_blurb_1">
    <div class="et_pb_blurb_content"><div class="et_pb_blurb_container">
      <div class="et_pb_blurb_description"><p>Full Time</p></div>
    </div></div>
  </div>
  <div class="et_pb_module et_pb_blurb et_pb_blurb_2">
    <div class="et_pb_blurb_content"><div class="et_pb_blurb_container">
      <div class="et_pb_blurb_description"><p>Location - ${opts.location}</p></div>
    </div></div>
  </div>
  <div class="et_pb_module et_pb_blurb et_pb_blurb_3">
    <div class="et_pb_blurb_content"><div class="et_pb_blurb_container">
      <div class="et_pb_blurb_description"><p>${opts.salary}</p></div>
    </div></div>
  </div>`;
}

const NUCLEAR_REACTOR = role({
  title: 'Nuclear Engineer',
  subtitle: 'Reactor Physics',
  body: 'We are seeking a Nuclear Engineer, Reactor Physics to perform reactor physics analyses. Email careers@nanonuclearenergy.com to apply.',
  location: 'Oak Brook, IL',
  salary: 'Salary: $120,000 - $160,000',
});

const NUCLEAR_PRA = role({
  title: 'Nuclear Engineer',
  subtitle: 'Probabilistic Risk Assessment',
  body: 'We are seeking an experienced PRA Engineer.',
  location: 'Oak Brook, IL',
  // Word-paste artifacts: spaces inside the number group.
  salary: 'Salary: $122,000 - $1 48 ,000',
});

const CIVIL = role({
  title: 'Civil Engineer',
  body: 'We are hiring a Civil Engineer.',
  location: 'Oak Brook, IL',
  // Word-paste artifacts: a missing `$` on the low end, space after `$`.
  salary: 'Salary: 99,000 - $ 131,000',
});

/** Wrap role blocks in a Divi page with a non-job heading before them. */
function page(...roles: string[]): string {
  return `<div class="et_pb_section">
    <div class="et_pb_module et_pb_text"><div class="et_pb_text_inner"><h2>Latest Job Listings</h2></div></div>
    ${roles.join('\n')}
  </div>`;
}

function respondWith(html: string) {
  mockGet.mockResolvedValue({ data: [{ id: 1, content: { rendered: html } }] });
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), overrides);
}

describe('NanonuclearenergyService', () => {
  beforeEach(() => mockGet.mockReset());

  it('parses each Divi role block into a job post', async () => {
    respondWith(page(NUCLEAR_REACTOR, NUCLEAR_PRA, CIVIL));
    const result = await new NanonuclearenergyService().scrape(inputFrom());
    expect(result.jobs).toHaveLength(3);

    const reactor = result.jobs[0];
    expect(reactor.site).toBe(Site.NANONUCLEARENERGY);
    expect(reactor.title).toBe('Nuclear Engineer');
    expect(reactor.companyName).toBe('NANO Nuclear Energy');
    expect(reactor.jobUrl).toBe('https://nanonuclearenergy.com/careers/');
    expect(reactor.employmentType).toBe('Full Time');
    expect(reactor.jobType).toEqual(['fulltime']);
    expect(reactor.location?.displayLocation()).toContain('Oak Brook');
    expect(reactor.isRemote).toBe(false);
    expect(reactor.description).toContain('Reactor Physics');
    expect(reactor.description).toContain('reactor physics analyses');
  });

  it('gives repeated titles distinct ids via the subtitle', async () => {
    respondWith(page(NUCLEAR_REACTOR, NUCLEAR_PRA));
    const result = await new NanonuclearenergyService().scrape(inputFrom());
    const ids = result.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('nanonuclearenergy-nuclear-engineer-reactor-physics');
    expect(ids).toContain(
      'nanonuclearenergy-nuclear-engineer-probabilistic-risk-assessment',
    );
  });

  it('parses a clean annual salary range', async () => {
    respondWith(page(NUCLEAR_REACTOR));
    const job = (await new NanonuclearenergyService().scrape(inputFrom()))
      .jobs[0];
    expect(job.compensation?.minAmount).toBe(120000);
    expect(job.compensation?.maxAmount).toBe(160000);
    expect(job.compensation?.interval).toBe('yearly');
  });

  it('repairs Word-paste artifacts: spaces inside the number group', async () => {
    respondWith(page(NUCLEAR_PRA));
    const job = (await new NanonuclearenergyService().scrape(inputFrom()))
      .jobs[0];
    expect(job.compensation?.minAmount).toBe(122000);
    expect(job.compensation?.maxAmount).toBe(148000);
    expect(job.compensation?.interval).toBe('yearly');
  });

  it('repairs a missing `$` and a space after `$`', async () => {
    respondWith(page(CIVIL));
    const job = (await new NanonuclearenergyService().scrape(inputFrom()))
      .jobs[0];
    expect(job.compensation?.minAmount).toBe(99000);
    expect(job.compensation?.maxAmount).toBe(131000);
    expect(job.compensation?.interval).toBe('yearly');
  });

  it('extracts the body apply email', async () => {
    respondWith(page(NUCLEAR_REACTOR));
    const job = (await new NanonuclearenergyService().scrape(inputFrom()))
      .jobs[0];
    expect(job.emails).toContain('careers@nanonuclearenergy.com');
  });

  it('returns empty when the page has no role blocks', async () => {
    respondWith('<div class="et_pb_section"><p>No openings.</p></div>');
    const result = await new NanonuclearenergyService().scrape(inputFrom());
    expect(result.jobs).toHaveLength(0);
  });

  it('returns empty when the REST response has no page', async () => {
    mockGet.mockResolvedValue({ data: [] });
    const result = await new NanonuclearenergyService().scrape(inputFrom());
    expect(result.jobs).toHaveLength(0);
  });

  it('returns empty (no throw) when the request fails', async () => {
    mockGet.mockRejectedValue(new Error('network'));
    const result = await new NanonuclearenergyService().scrape(inputFrom());
    expect(result.jobs).toHaveLength(0);
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    respondWith(page(NUCLEAR_REACTOR, NUCLEAR_PRA, CIVIL));

    const filtered = await new NanonuclearenergyService().scrape(
      inputFrom({ searchTerm: 'Civil' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Civil Engineer');

    const capped = await new NanonuclearenergyService().scrape(
      inputFrom({ resultsWanted: 2 }),
    );
    expect(capped.jobs).toHaveLength(2);
  });
});
