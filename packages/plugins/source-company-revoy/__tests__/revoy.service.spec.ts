import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const indexHtml = readFileSync(join(__dirname, 'fixtures', 'join-the-team.html'), 'utf8');
const financeTxt = readFileSync(join(__dirname, 'fixtures', 'doc-finance.txt'), 'utf8');
const supplyTxt = readFileSync(join(__dirname, 'fixtures', 'doc-supplychain.txt'), 'utf8');

const FINANCE_DOC = '1WC76MafLD0dZtyIr6yDS9jnhpkFbTHoM';
const SUPPLY_DOC = '15bZxb5kd1M9Ptu9qIDa6YTbvx9EBLv6W';

const pages: Record<string, string> = {
  'https://www.revoy.com/join-the-team': indexHtml,
  [`https://docs.google.com/document/d/${FINANCE_DOC}/export?format=txt`]: financeTxt,
  [`https://docs.google.com/document/d/${SUPPLY_DOC}/export?format=txt`]: supplyTxt,
};

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { RevoyService } from '../src/revoy.service';

function respondWith(p: Record<string, string>): void {
  getMock.mockReset();
  getMock.mockImplementation((url: string) => {
    const data = p[url];
    if (data === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve({ data });
  });
}

function live(): void {
  respondWith(pages);
}

describe('RevoyService', () => {
  let service: RevoyService;

  beforeEach(() => {
    getMock.mockReset();
    service = new RevoyService();
  });

  it('maps every docs link to a job keyed by doc id', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(2);
    expect(res.diagnostics).toBeUndefined();

    const fin = res.jobs.find((j) => j.title === 'Head of Finance');
    expect(fin).toBeDefined();
    expect(fin!.id).toBe(`revoy-${FINANCE_DOC}`);
    expect(fin!.atsId).toBe(FINANCE_DOC);
    expect(fin!.site).toBe(Site.REVOY);
    expect(fin!.atsType).toBe('revoy');
    expect(fin!.companyName).toBe('Revoy');
    expect(fin!.jobUrl).toBe(
      `https://docs.google.com/document/d/${FINANCE_DOC}/edit`,
    );
    expect(fin!.jobUrlDirect).toBe(fin!.jobUrl);
    expect(fin!.applyUrl).toBe(fin!.jobUrl);
  });

  it('fetches the index then one txt export per doc', async () => {
    live();
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenCalledTimes(3);
    const urls = getMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('https://www.revoy.com/join-the-team');
    expect(urls).toContain(
      `https://docs.google.com/document/d/${FINANCE_DOC}/export?format=txt`,
    );
    expect(urls).toContain(
      `https://docs.google.com/document/d/${SUPPLY_DOC}/export?format=txt`,
    );
  });

  it('uses the doc Location when labeled, else the link location', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));

    const supply = res.jobs.find((j) => j.title === 'Lead Supply chain Engineer');
    expect(supply).toBeDefined();
    // doc says "Troutdale, OR (on-site)"; the link says "Portland, OR"
    expect(supply!.location?.city).toBe('Troutdale');
    expect(supply!.location?.state).toBe('OR');
    expect(supply!.workFromHomeType).toBe('On Site');

    const fin = res.jobs.find((j) => j.title === 'Head of Finance');
    expect(fin!.location?.city).toBe('Portland');
    expect(fin!.location?.state).toBe('OR');
  });

  it('extracts labeled doc headers into fields', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const supply = res.jobs.find((j) => j.title === 'Lead Supply chain Engineer')!;
    expect(supply.department).toBe('Operations / Engineering');
    expect(supply.employmentType).toBe('Full-time');
    expect(supply.jobType).toBeDefined();
  });

  it('carries the full doc body as description', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const fin = res.jobs.find((j) => j.title === 'Head of Finance')!;
    expect(fin.description).toContain('Why Revoy');
    expect(fin.description).toContain('REPORTS TO');
    expect(fin.description!.length).toBeGreaterThan(1000);
  });

  it('degrades to link-only fields when a doc fetch fails', async () => {
    respondWith({
      'https://www.revoy.com/join-the-team': indexHtml,
      // both doc exports missing → 404
    });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(2);
    const fin = res.jobs.find((j) => j.title === 'Head of Finance')!;
    expect(fin.location?.city).toBe('Portland');
    expect(fin.location?.state).toBe('OR');
    expect(fin.description).toBeUndefined();
    expect(fin.applyUrl).toBe(`https://docs.google.com/document/d/${FINANCE_DOC}/edit`);
  });

  it('returns an empty diagnostic when no doc links exist', async () => {
    respondWith({ 'https://www.revoy.com/join-the-team': '<html><body>empty</body></html>' });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns a classified diagnostic when the index fetch throws', async () => {
    getMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBeDefined();
  });

  it('honours searchTerm, location, and resultsWanted filters', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({ searchTerm: 'Finance' }));
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Head of Finance');

    live();
    const loc = await service.scrape(new ScraperInputDto({ location: 'troutdale' }));
    expect(loc.jobs).toHaveLength(1);
    expect(loc.jobs[0].title).toBe('Lead Supply chain Engineer');

    live();
    const limited = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, offset: 1 }),
    );
    expect(limited.jobs).toHaveLength(1);
    expect(limited.jobs[0].title).toBe('Lead Supply chain Engineer');
  });
});
