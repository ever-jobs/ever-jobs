import 'reflect-metadata';
import { StreamableFile } from '@nestjs/common';
import { JobPostDto, LocationDto, ScraperInputDto } from '@ever-jobs/models';
import { JobsController } from '../jobs.controller';

/**
 * Spec 1720 (controller side) — list-mode normalisation happens before the
 * request log and the cache lookup; Spec 1721 — CSV keeps extra fields and
 * gains `dedupKey`, nested arrays are readable.
 */

function createController(jobs: JobPostDto[] = []) {
  const cacheService = {
    get: jest.fn(async (_params: unknown) => null),
    set: jest.fn(async (_params: unknown, _value: unknown) => undefined),
  };
  const jobsService = { searchJobsWithDiagnostics: jest.fn(async () => ({ jobs, perSource: [] })) };
  const controller = new JobsController(
    jobsService as any,
    {
      aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
        jobs: raw,
        rawCount: raw.length,
        outputCount: raw.length,
        deduped: false,
      })),
    } as any,
    {} as any,
    cacheService as any,
    { get: (_k: string, def?: unknown) => def } as any,
  );
  const log = jest.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);
  return { controller, cacheService, jobsService, log };
}

describe('JobsController — list mode (Spec 1720)', () => {
  it.each([
    ['omitted', {}],
    ['empty string', { searchTerm: '' }],
    ['whitespace', { searchTerm: '   ' }],
    ['null', { searchTerm: null }],
  ])('logs term=<none> when searchTerm is %s', async (_label, body) => {
    const { controller, log } = createController();
    await controller.searchJobs(Object.assign(new ScraperInputDto(), body));
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Search request:'))!;
    expect(line).toContain('term=<none>');
    expect(line).not.toMatch(/undefined|null/);
  });

  it('logs the quoted keyword otherwise', async () => {
    const { controller, log } = createController();
    await controller.searchJobs(new ScraperInputDto({ searchTerm: ' nurse ', location: 'Leeds' }));
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Search request:'))!;
    expect(line).toContain('term="nurse"');
    expect(line).toContain('location="Leeds"');
  });

  it('logs requested categories', async () => {
    const { controller, log } = createController();
    await controller.searchJobs(new ScraperInputDto({ siteCategories: ['job-board', 'remote'] }));
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Search request:'))!;
    expect(line).toContain('categories=job-board,remote');
  });

  it('"" / "   " / null / omitted share one cache entry', async () => {
    const keys: unknown[] = [];
    for (const body of [{}, { searchTerm: '' }, { searchTerm: '   ' }, { searchTerm: null }]) {
      const { controller, cacheService } = createController();
      await controller.searchJobs(Object.assign(new ScraperInputDto(), body));
      keys.push(JSON.stringify(cacheService.get.mock.calls[0]![0]));
    }
    expect(new Set(keys).size).toBe(1);
    expect(String(keys[0])).not.toContain('searchTerm');
  });

  it('siteCategories is part of the cache key (it changes the result set)', async () => {
    const a = createController();
    const b = createController();
    await a.controller.searchJobs(new ScraperInputDto({ siteCategories: ['company'] }));
    await b.controller.searchJobs(new ScraperInputDto({ siteCategories: ['job-board'] }));
    expect(a.cacheService.get.mock.calls[0]![0]).not.toEqual(b.cacheService.get.mock.calls[0]![0]);
  });

  it('hands the service an input with no searchTerm key in list mode', async () => {
    const { controller, jobsService } = createController();
    await controller.searchJobs(Object.assign(new ScraperInputDto(), { searchTerm: '  ' }));
    const passed = (jobsService.searchJobsWithDiagnostics.mock.calls[0] as unknown[])[0] as ScraperInputDto;
    expect('searchTerm' in passed).toBe(false);
  });
});

describe('JobsController — CSV carries dedupKey and extra fields (Spec 1721)', () => {
  async function csvFor(jobs: JobPostDto[]): Promise<string[][]> {
    const { controller } = createController(jobs);
    const file = (await controller.searchJobs(
      new ScraperInputDto({}),
      'csv',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { setHeader: jest.fn() } as any,
    )) as StreamableFile;
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(','));
  }

  it('has a dedupKey column and flattens nested arrays with "; "', async () => {
    const job = new JobPostDto({
      id: '1',
      title: 'Engineer',
      companyName: 'Acme',
      jobUrl: 'https://example.com/1',
      location: new LocationDto({ city: 'Paris' }),
      dedupKey: 'abc123',
    });
    Object.assign(job, { careerLevel: { level: 'senior', confidence: 'high', reasons: ['title', 'years'] } });

    const [header, row] = await csvFor([job]);
    const col = (name: string) => row![header!.indexOf(name)];
    expect(header).toContain('dedupKey');
    expect(col('dedupKey')).toBe('abc123');
    expect(col('careerLevel.level')).toBe('senior');
    expect(col('careerLevel.reasons')).toBe('title; years');
  });
});
