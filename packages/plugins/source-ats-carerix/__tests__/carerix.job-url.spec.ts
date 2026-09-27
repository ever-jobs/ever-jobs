/**
 * Carerix link mapping (Spec 1751 T11). The link is built one step before the
 * DTO — `normaliseJob` stores `url: feedJob.url ?? this.buildJobUrl(…)` in a
 * record and `processJob` copies `job.url` into `jobUrl` / `applyUrl` — the
 * shape the static guard could not follow until T11 (mutant M7). This suite
 * pins the runtime behaviour: the feed's own `<url>` wins, else the tenant's
 * public `…/vacature-<publicationID>` page, never an API host.
 *
 * The feed body follows the documented CxTools Indeed schema
 * (`<source><job>…</job></source>`); no live tenant feed was fetched.
 */
import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { isApiLikeUrl } from '@ever-jobs/common';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: jest.fn(), setHeaders: jest.fn() })),
  };
});

import { CarerixService } from '../src/carerix.service';

function job(ref: string, url?: string): string {
  return [
    '<job>',
    `  <title><![CDATA[Recruiter ${ref}]]></title>`,
    `  <referencenumber>${ref}</referencenumber>`,
    url ? `  <url><![CDATA[${url}]]></url>` : '',
    '  <company>Acme Detachering</company>',
    '  <city>Utrecht</city>',
    '  <country>NL</country>',
    '  <date>2026-09-20</date>',
    '</job>',
  ].join('\n');
}

async function scrape(jobs: string[]) {
  mockGet.mockReset();
  mockGet.mockResolvedValueOnce({ data: `<?xml version="1.0"?><source>${jobs.join('')}</source>` });
  return new CarerixService().scrape({
    siteType: [Site.CARERIX],
    companySlug: 'acme',
    resultsWanted: 10,
  } as ScraperInputDto);
}

describe('CarerixService — job links (Spec 1751 T11)', () => {
  it('reads the tenant Indeed feed and keeps the publication <url>', async () => {
    const result = await scrape([job('4321', 'https://www.acme.nl/vacatures/recruiter-4321')]);
    expect(mockGet.mock.calls[0][0]).toBe('https://acme.carerix.com/cxtools/indeedFeed.php');
    expect(result.jobs[0].jobUrl).toBe('https://www.acme.nl/vacatures/recruiter-4321');
    expect(result.jobs[0].applyUrl).toBe('https://www.acme.nl/vacatures/recruiter-4321');
  });

  it('without a <url>, links the public …/vacature-<publicationID> page built by buildJobUrl', async () => {
    const result = await scrape([job('98765')]);
    expect(result.jobs[0].jobUrl).toBe('https://acme.carerix.com/vacature-98765');
    expect(result.jobs[0].applyUrl).toBe('https://acme.carerix.com/vacature-98765');
    expect(result.jobs[0].atsId).toBe('98765');
  });

  it('never produces an API-shaped link', async () => {
    const result = await scrape([job('1111'), job('2222', 'https://acme.carerix.com/vacature-2222')]);
    for (const post of result.jobs) {
      expect(isApiLikeUrl(post.jobUrl)).toBe(false);
      expect(isApiLikeUrl(post.applyUrl)).toBe(false);
    }
  });
});
