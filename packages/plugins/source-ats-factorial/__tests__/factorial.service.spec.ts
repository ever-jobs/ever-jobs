/**
 * Unit tests for the Factorial ATS scraper.
 *
 * `createHttpClient` is mocked to serve the captured fixtures in
 * `__tests__/fixtures/` — an index page, a job-detail page and a sitemap on
 * the canonical `factorial.com` apex (the legacy `factorialhr.com`
 * sub-domain is exercised only by the host-fallback cases).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { FactorialModule, FactorialService } from '@ever-jobs/source-ats-factorial';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, setHeaders: mockSetHeaders })),
  };
});

const FIXTURES = join(__dirname, 'fixtures');
const indexHtml = readFileSync(join(FIXTURES, 'factorial-index.html'), 'utf8');
const detailHtml = readFileSync(join(FIXTURES, 'factorial-detail.html'), 'utf8');
const sitemapXml = readFileSync(join(FIXTURES, 'factorial-sitemap.xml'), 'utf8');

/** Route every GET by URL shape to the matching fixture. */
function happyPath() {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/sitemap.xml')) return Promise.resolve({ data: sitemapXml });
    if (url.includes('/job_posting/')) return Promise.resolve({ data: detailHtml });
    return Promise.resolve({ data: indexHtml });
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.FACTORIAL],
    companySlug: 'acme',
    descriptionFormat: DescriptionFormat.PLAIN,
    ...overrides,
  });
}

describe('FactorialService (unit)', () => {
  let service: FactorialService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [FactorialModule],
    }).compile();
    service = module.get<FactorialService>(FactorialService);
  });

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    happyPath();
  });

  it('maps the captured index + detail + sitemap fixtures to JobPostDtos', async () => {
    const response = await service.scrape(input());

    expect(response.jobs).toHaveLength(2);

    const job = response.jobs[0];
    expect(job.id).toBe('factorial-325521');
    expect(job.atsId).toBe('325521');
    expect(job.atsType).toBe('factorial');
    expect(job.site).toBe(Site.FACTORIAL);
    expect(job.title).toBe('Senior Engineer');
    expect(job.companyName).toBe('Acme');
    expect(job.jobUrl).toBe('https://acme.factorial.com/job_posting/senior-engineer-325521');
    expect(job.applyUrl).toBe('https://acme.factorial.com/apply/senior-engineer-325521');
    expect(job.datePosted).toBe('2026-09-15');
    expect(job.isRemote).toBe(true);
    expect(job.department).toBe('Engineering');
    expect(job.location?.city).toBe('Monterrey');
    expect(job.location?.country).toBe('Mexico');
    expect(job.locations).toHaveLength(1);
    expect(job.description).toContain('backend services');

    const second = response.jobs[1];
    expect(second.atsId).toBe('312102');
    expect(second.isRemote).toBe(false);
    expect(second.datePosted).toBe('2026-08-30');
  });

  it('fetches the canonical factorial.com host first', async () => {
    await service.scrape(input());
    expect(mockGet.mock.calls[0][0]).toBe('https://acme.factorial.com/');
  });

  it('falls back to the legacy factorialhr.com host when the canonical fetch fails', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === 'https://acme.factorial.com/') {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }
      if (url.endsWith('/sitemap.xml')) return Promise.resolve({ data: sitemapXml });
      if (url.includes('/job_posting/')) return Promise.resolve({ data: detailHtml });
      return Promise.resolve({ data: indexHtml });
    });

    const response = await service.scrape(input());

    expect(mockGet.mock.calls[0][0]).toBe('https://acme.factorial.com/');
    expect(mockGet.mock.calls[1][0]).toBe('https://acme.factorialhr.com/');
    expect(response.jobs).toHaveLength(2);
    // Embedded job URLs stay on the page's own apex.
    expect(response.jobs[0].jobUrl).toContain('acme.factorial.com');
  });

  it('returns an empty result when every host fails', async () => {
    mockGet.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const response = await service.scrape(input());

    expect(response.jobs).toHaveLength(0);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('resolves the slug from companyUrl when companySlug is absent', async () => {
    const response = await service.scrape(
      input({ companySlug: undefined, companyUrl: 'https://acme.factorial.com' }),
    );

    expect(response.jobs).toHaveLength(2);
    expect(response.jobs[0].companyName).toBe('Acme');
  });

  it('returns an empty result without fetching when neither slug nor URL is given', async () => {
    const response = await service.scrape(
      input({ companySlug: undefined, companyUrl: undefined }),
    );

    expect(response.jobs).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('honours resultsWanted', async () => {
    const response = await service.scrape(input({ resultsWanted: 1 }));
    expect(response.jobs).toHaveLength(1);
  });
});
