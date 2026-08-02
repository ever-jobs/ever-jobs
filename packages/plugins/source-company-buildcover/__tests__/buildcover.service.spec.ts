import 'reflect-metadata';
import { CompensationInterval, ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet })),
  };
});

import { BuildcoverService } from '../src/buildcover.service';

/** A Portable-Text paragraph block. */
function para(text: string) {
  return {
    _type: 'block',
    style: 'normal',
    children: [{ _type: 'span', text }],
  };
}

/** A Portable-Text bullet list-item block. */
function bullet(text: string) {
  return {
    _type: 'block',
    style: 'normal',
    listItem: 'bullet',
    level: 1,
    children: [{ _type: 'span', text }],
  };
}

const FOREMAN = {
  _id: 'career-foreman',
  title: 'Foreman',
  slug: 'foreman',
  location: 'Gardena, Los Angeles (On-Site)',
  type: 'Full-Time',
  _createdAt: '2025-02-01T10:00:00Z',
  _updatedAt: '2025-03-01T10:00:00Z',
  overview: [para('Lead the install crew on site.')],
  role: [bullet('Run daily standups'), bullet('Coordinate subcontractors')],
  experience: [bullet('5+ years construction'), bullet('OSHA 30')],
  extraSections: [
    { title: 'Schedule', content: [bullet('8-hour shift'), bullet('Weekends as required')] },
  ],
  compensation: [para('$35.00/hr – $40.00/hr depending on experience.')],
};

const MARKETING = {
  _id: 'career-marketing',
  title: 'Marketing Manager',
  slug: 'marketing-manager',
  location: 'Remote',
  type: 'Full-Time',
  _createdAt: '2025-01-15T10:00:00Z',
  overview: [para('Own the brand and demand-gen.')],
  role: [bullet('Plan campaigns')],
  experience: [bullet('Growth marketing background')],
  extraSections: [],
  compensation: [],
};

function respondWith(result: unknown) {
  mockGet.mockResolvedValue({ data: { result } });
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), overrides);
}

describe('BuildcoverService', () => {
  beforeEach(() => mockGet.mockReset());

  it('maps Cover Sanity career docs to job posts with the global apply email', async () => {
    respondWith({ contactEmail: 'join@buildcover.com', careers: [FOREMAN, MARKETING] });

    const result = await new BuildcoverService().scrape(inputFrom());
    expect(result.jobs).toHaveLength(2);

    const foreman = result.jobs.find((j) => j.title === 'Foreman')!;
    expect(foreman).toBeDefined();
    expect(foreman.site).toBe(Site.BUILDCOVER);
    expect(foreman.id).toBe('buildcover-foreman');
    expect(foreman.companyName).toBe('Cover');
    expect(foreman.jobUrl).toBe('https://buildcover.com/careers/foreman/');
    // apply email comes from the global careersPage.contactEmail; it lives in
    // `emails`, and `applyUrl` is left unset (a mailto: is not a web URL)
    expect(foreman.emails).toEqual(['join@buildcover.com']);
    expect(foreman.applyUrl == null).toBe(true);
    expect(foreman.datePosted).toBe('2025-02-01');
  });

  it('parses location (on-site stripped), employmentType, and jobType', async () => {
    respondWith({ contactEmail: 'join@buildcover.com', careers: [FOREMAN, MARKETING] });
    const result = await new BuildcoverService().scrape(inputFrom());

    const foreman = result.jobs.find((j) => j.title === 'Foreman')!;
    expect(foreman.location?.displayLocation()).toContain('Los Angeles');
    expect(foreman.location?.displayLocation()).not.toMatch(/on-?site/i);
    expect(foreman.isRemote).toBe(false);
    expect(foreman.employmentType).toBe('Full-Time');
    expect(foreman.jobType).toEqual(['fulltime']);

    const marketing = result.jobs.find((j) => j.title === 'Marketing Manager')!;
    expect(marketing.isRemote).toBe(true);
  });

  it('renders Portable-Text sections under Cover section labels', async () => {
    respondWith({ contactEmail: 'join@buildcover.com', careers: [FOREMAN] });
    const foreman = (await new BuildcoverService().scrape(inputFrom())).jobs[0];

    expect(foreman.description).toContain('## Overview');
    expect(foreman.description).toContain('Lead the install crew on site.');
    expect(foreman.description).toContain('## Role');
    expect(foreman.description).toContain('- Run daily standups');
    expect(foreman.description).toContain('## Experience');
    // extraSections render under their own title, after Experience
    expect(foreman.description).toContain('## Schedule');
    expect(foreman.description).toContain('- 8-hour shift');
    expect(foreman.description).toContain('## Compensation');
  });

  it('parses a compensation range and takes the interval from the /hr token', async () => {
    respondWith({ contactEmail: 'join@buildcover.com', careers: [FOREMAN] });
    const foreman = (await new BuildcoverService().scrape(inputFrom())).jobs[0];

    expect(foreman.compensation).not.toBeNull();
    expect(foreman.compensation?.minAmount).toBe(35);
    expect(foreman.compensation?.maxAmount).toBe(40);
    expect(foreman.compensation?.interval).toBe(CompensationInterval.HOURLY);
  });

  it('honours a /yr token whose magnitude would otherwise read as monthly', async () => {
    const analyst = {
      ...MARKETING,
      title: 'Operations Analyst',
      slug: { current: 'operations-analyst' },
      compensation: [para('$28,000 – $32,000 /yr')],
    };
    respondWith({ contactEmail: 'join@buildcover.com', careers: [analyst] });
    const job = (await new BuildcoverService().scrape(inputFrom())).jobs[0];

    // Without the token hint the shared parser would infer MONTHLY (28000 <
    // 30000); the /yr token keeps it YEARLY.
    expect(job.compensation?.minAmount).toBe(28000);
    expect(job.compensation?.maxAmount).toBe(32000);
    expect(job.compensation?.interval).toBe(CompensationInterval.YEARLY);
  });

  it('omits compensation when there is no salary text', async () => {
    respondWith({ contactEmail: 'join@buildcover.com', careers: [MARKETING] });
    const marketing = (await new BuildcoverService().scrape(inputFrom())).jobs[0];
    expect(marketing.compensation ?? null).toBeNull();
  });

  it('returns empty when the query yields no careers', async () => {
    respondWith({ contactEmail: 'join@buildcover.com', careers: [] });
    const result = await new BuildcoverService().scrape(inputFrom());
    expect(result.jobs).toHaveLength(0);
  });

  it('returns empty (no throw) when the request fails', async () => {
    mockGet.mockRejectedValue(new Error('network'));
    const result = await new BuildcoverService().scrape(inputFrom());
    expect(result.jobs).toHaveLength(0);
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    respondWith({ contactEmail: 'join@buildcover.com', careers: [FOREMAN, MARKETING] });

    const filtered = await new BuildcoverService().scrape(
      inputFrom({ searchTerm: 'Marketing' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Marketing Manager');

    const capped = await new BuildcoverService().scrape(inputFrom({ resultsWanted: 1 }));
    expect(capped.jobs).toHaveLength(1);
  });
});
