/**
 * NAV (arbeidsplassen.nav.no) link mapping (Spec 1751): a feed item's `url` is
 * the feed's API resource (`/api/v1/feedentry/<uuid>`) and must never become
 * `jobUrl`. Item shape per the pam-stilling-feed JSON Feed (`items[]` with a
 * `_feed_entry`).
 */
import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: jest.fn(), setHeaders: jest.fn() })),
  };
});

import { NavJobsService } from '../src/navjobs.service';

const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

function item(entry: Record<string, unknown>): any {
  return {
    id: UUID,
    url: `/api/v1/feedentry/${UUID}`,
    title: 'Sykepleier',
    date_modified: '2026-09-20T10:00:00',
    _feed_entry: {
      uuid: UUID,
      status: 'ACTIVE',
      title: 'Sykepleier',
      businessName: 'Oslo kommune',
      municipal: 'Oslo',
      ...entry,
    },
  };
}

async function scrape(items: any[]) {
  const saved = process.env.NAVJOBS_TOKEN;
  process.env.NAVJOBS_TOKEN = 'test-token';
  try {
    mockGet.mockReset();
    mockGet.mockResolvedValueOnce({ data: { version: '1', title: 'feed', items } });
    return await new NavJobsService().scrape({ siteType: [Site.NAVJOBS], resultsWanted: 10 } as ScraperInputDto);
  } finally {
    if (saved === undefined) delete process.env.NAVJOBS_TOKEN;
    else process.env.NAVJOBS_TOKEN = saved;
  }
}

describe('NavJobsService — job links (Spec 1751)', () => {
  it('keeps applicationUrl as the link and exposes it as applyUrl', async () => {
    const result = await scrape([item({ applicationUrl: 'https://employer.no/apply/1', sourceurl: 'https://employer.no/jobs/1' })]);
    expect(result.jobs[0].jobUrl).toBe('https://employer.no/apply/1');
    expect(result.jobs[0].applyUrl).toBe('https://employer.no/apply/1');
  });

  it('uses sourceurl when there is no applicationUrl', async () => {
    const result = await scrape([item({ sourceurl: 'https://employer.no/jobs/1' })]);
    expect(result.jobs[0].jobUrl).toBe('https://employer.no/jobs/1');
    expect(result.jobs[0].applyUrl ?? null).toBeNull();
  });

  it('never falls back to the feed API url; links the public ad page', async () => {
    const result = await scrape([item({ applicationUrl: 'Send søknad på e-post', sourceurl: null })]);
    expect(result.jobs[0].jobUrl).toBe(`https://arbeidsplassen.nav.no/stillinger/stilling/${UUID}`);
    expect(result.jobs[0].jobUrl).not.toContain('/api/');
    expect(result.jobs[0].applyUrl ?? null).toBeNull();
  });
});
