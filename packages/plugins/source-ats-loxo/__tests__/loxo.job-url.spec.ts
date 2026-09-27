/**
 * Loxo link mapping (Spec 1751): the posting's public `url` / `apply_url`, then
 * the caller's careers page; the API resource is only a last resort (Q-110).
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

import { LoxoService } from '../src/loxo.service';

function job(id: number, extra: Record<string, unknown> = {}): any {
  return { id, title: `Role ${id}`, description: '<p>Body</p>', location: 'Remote', ...extra };
}

async function scrape(jobs: any[], companyUrl?: string) {
  mockGet.mockReset();
  mockGet.mockResolvedValueOnce({ data: jobs });
  const saved = process.env.LOXO_API_TOKEN;
  delete process.env.LOXO_API_TOKEN;
  try {
    return await new LoxoService().scrape({
      siteType: [Site.LOXO],
      companySlug: 'acme-agency',
      resultsWanted: 10,
      ...(companyUrl ? { companyUrl } : {}),
    } as ScraperInputDto);
  } finally {
    if (saved !== undefined) process.env.LOXO_API_TOKEN = saved;
  }
}

describe('LoxoService — job links (Spec 1751)', () => {
  it('keeps the public url and apply_url', async () => {
    const result = await scrape([
      job(1, { url: 'https://app.loxo.co/job/MS0x', apply_url: 'https://app.loxo.co/job/MS0x/apply' }),
    ]);
    expect(result.jobs[0].jobUrl).toBe('https://app.loxo.co/job/MS0x');
    expect(result.jobs[0].applyUrl).toBe('https://app.loxo.co/job/MS0x/apply');
  });

  it('refuses an API-shaped url and falls through to apply_url', async () => {
    const result = await scrape([
      job(2, { url: 'https://app.loxo.co/api/acme-agency/jobs/2', apply_url: 'https://app.loxo.co/job/Mi0y/apply' }),
    ]);
    expect(result.jobs[0].jobUrl).toBe('https://app.loxo.co/job/Mi0y/apply');
  });

  it('prefers the caller careers page over the API fallback', async () => {
    const result = await scrape([job(3)], 'https://careers.acme.com/');
    expect(result.jobs[0].jobUrl).toBe('https://careers.acme.com/');
    expect(result.jobs[0].applyUrl ?? null).toBeNull();
  });

  it('documents the last resort when nothing public is known (Q-110)', async () => {
    const result = await scrape([job(4)]);
    expect(result.jobs[0].jobUrl).toBe('https://app.loxo.co/api/acme-agency/jobs/4');
  });
});
