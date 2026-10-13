import * as fs from 'fs';
import * as path from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { CommaAiService } from '../src/comma-ai.service';

const JOBS_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'jobs.html'), 'utf-8');
const CHUNK_JS = fs.readFileSync(path.join(__dirname, 'fixtures', 'node-chunk.js'), 'utf-8');
const CHUNK_PATH = '/_app/immutable/nodes/4.CaK98CBr.js';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: jest.fn() };
});
const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
  createHttpClient: jest.Mock;
};

function mockClient(html = JOBS_HTML, chunk: string | null = CHUNK_JS) {
  const getMock = jest.fn((url: string) => {
    if (url === 'https://comma.ai/jobs') return Promise.resolve({ data: html });
    // only the jobs node chunk carries the array; other node chunks are dead ends
    if (url === `https://comma.ai${CHUNK_PATH}`) {
      return chunk !== null ? Promise.resolve({ data: chunk }) : Promise.reject(new Error('404'));
    }
    if (url.endsWith('.js')) return Promise.resolve({ data: 'const x = 1;' });
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  createHttpClient.mockReturnValue({ get: getMock, setHeaders: jest.fn() });
  return getMock;
}

describe('CommaAiService', () => {
  const service = new CommaAiService();
  const input = new ScraperInputDto({ siteType: [Site.COMMA_AI] });

  beforeEach(() => jest.clearAllMocks());

  it('discovers the node chunk from the page and parses 10 jobs', async () => {
    const getMock = mockClient();
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(10);
    const urls = getMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('https://comma.ai/jobs');
    expect(urls).toContain(`https://comma.ai${CHUNK_PATH}`);
    expect(res.diagnostics).toBeUndefined();
  });

  it('maps title, slug, site, and company fields', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.title === 'Software Engineer');
    expect(job).toBeDefined();
    expect(job!.id).toBe('comma_ai-software-engineer');
    expect(job!.atsId).toBe('software-engineer');
    expect(job!.site).toBe(Site.COMMA_AI);
    expect(job!.atsType).toBe('comma_ai');
    expect(job!.companyName).toBe('comma');
    expect(job!.jobUrl).toBe('https://comma.ai/jobs#software-engineer');
    expect(job!.applyUrl).toBe('https://comma.ai/jobs#software-engineer');
  });

  it('derives kebab slugs from titles with slashes and capitals', async () => {
    mockClient();
    const res = await service.scrape(input);
    const byAts = res.jobs.map((j) => j.atsId);
    expect(byAts).toContain('video-content-creator');
    expect(byAts).toContain('internships-co-op');
    expect(byAts).toContain('cnc-machinist-head-of-prototyping');
  });

  it('maps team to department and omits it when absent', async () => {
    mockClient();
    const res = await service.scrape(input);
    const eng = res.jobs.find((j) => j.atsId === 'software-engineer');
    expect(eng!.department).toBe('openpilot');
    const intern = res.jobs.find((j) => j.atsId === 'internships-co-op');
    expect(intern).toBeDefined();
    expect(intern!.department).toBeUndefined();
  });

  it('parses the on-site San Diego location to city and state', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'software-engineer');
    expect(job!.location?.city).toBe('San Diego');
    expect(job!.location?.state).toBe('CA');
  });

  it('composes description from the bundle fields', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'software-engineer');
    expect(job!.description).toContain('openpilot team');
    expect(job!.description).toContain('Qualifications:');
    expect(job!.description).toContain('Fluent in Python');
  });

  it('returns empty diagnostics when no chunk carries the jobs array', async () => {
    mockClient(JOBS_HTML, 'const x = 1;');
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });
});
