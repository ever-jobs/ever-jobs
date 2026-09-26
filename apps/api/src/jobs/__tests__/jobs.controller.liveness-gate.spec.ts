import 'reflect-metadata';
import { StreamableFile } from '@nestjs/common';
import { JobPostDto, ScraperInputDto } from '@ever-jobs/models';
import { JobsController } from '../jobs.controller';

/**
 * Spec 1723 — liveness server gate (`EVER_JOBS_LIVENESS_ENABLED`) and
 * per-request cap (`EVER_JOBS_LIVENESS_MAX_URLS`) on the JSON / CSV paths.
 * The NDJSON path is covered in `jobs.controller.ndjson.spec.ts`.
 */

function makeJobs(n: number): JobPostDto[] {
  return Array.from(
    { length: n },
    (_, i) =>
      new JobPostDto({
        id: `j${i}`,
        title: `Job ${i}`,
        companyName: 'Acme',
        jobUrl: `https://example.com/jobs/${i}`,
      }),
  );
}

function createController(jobs: JobPostDto[], config: Record<string, unknown> = {}) {
  const probed: string[][] = [];
  const liveness = {
    check: jest.fn(),
    checkBatch: jest.fn(async (urls: string[]) => {
      probed.push(urls);
      return urls.map((url) => ({ url, result: 'active', code: 'ok', checkedAt: '2026-09-24T00:00:00Z' }));
    }),
  };
  const legitimacy = {
    assess: jest.fn(),
    assessBatch: jest.fn((inputs: unknown[]) => inputs.map(() => ({ state: 'likely', reasons: ['r'] }))),
  };
  const controller = new JobsController(
    { searchJobsWithDiagnostics: jest.fn(async () => ({ jobs, perSource: [] })) } as any,
    {
      aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
        jobs: raw,
        rawCount: raw.length,
        outputCount: raw.length,
        deduped: false,
      })),
    } as any,
    {} as any,
    { get: jest.fn(async () => null), set: jest.fn(async () => undefined) } as any,
    { get: (key: string, def?: unknown) => (key in config ? config[key] : def) } as any,
    liveness as any,
    legitimacy as any,
  );
  const warn = jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);
  return { controller, liveness, legitimacy, probed, warn };
}

/** Positional call: (input, format, paginate, page, page_size, dedup, liveness, legitimacy, res). */
function search(
  controller: JobsController,
  q: { format?: string; paginate?: string; page?: string; pageSize?: string; liveness?: string; legitimacy?: string },
  res?: unknown,
) {
  return controller.searchJobs(
    new ScraperInputDto({ searchTerm: 'x' }),
    q.format,
    q.paginate,
    q.page,
    q.pageSize,
    undefined,
    q.liveness,
    q.legitimacy,
    res as any,
  );
}

describe('JobsController — liveness server gate (Spec 1723)', () => {
  it('does not probe when the request does not ask for it (default off)', async () => {
    const { controller, liveness } = createController(makeJobs(3));
    const result = (await search(controller, {})) as { jobs: JobPostDto[] };
    expect(liveness.checkBatch).not.toHaveBeenCalled();
    expect(result.jobs.every((j) => j.liveness === undefined)).toBe(true);
  });

  it('probes when requested and the gate is on (default)', async () => {
    const { controller, liveness } = createController(makeJobs(3));
    const result = (await search(controller, { liveness: 'true' })) as { jobs: JobPostDto[] };
    expect(liveness.checkBatch).toHaveBeenCalledTimes(1);
    expect(result.jobs.every((j) => j.liveness?.state === 'active')).toBe(true);
  });

  it.each([false])('EVER_JOBS_LIVENESS_ENABLED=%s refuses ?liveness=true: no probe, no liveness field', async (enabled) => {
    const { controller, liveness } = createController(makeJobs(3), { 'liveness.enabled': enabled });
    const result = (await search(controller, { liveness: 'true' })) as { jobs: JobPostDto[] };
    expect(liveness.checkBatch).not.toHaveBeenCalled();
    for (const job of result.jobs) {
      expect(job.liveness).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain('liveness');
    }
  });

  it('legitimacy still runs when liveness is gated off', async () => {
    const { controller, liveness, legitimacy } = createController(makeJobs(2), { 'liveness.enabled': false });
    const result = (await search(controller, { liveness: 'true', legitimacy: 'true' })) as { jobs: JobPostDto[] };
    expect(liveness.checkBatch).not.toHaveBeenCalled();
    expect(legitimacy.assessBatch).toHaveBeenCalledTimes(1);
    expect(result.jobs.every((j) => j.legitimacy?.state === 'likely')).toBe(true);
  });

  it('caps probes at EVER_JOBS_LIVENESS_MAX_URLS; later jobs carry no liveness', async () => {
    const { controller, probed, warn } = createController(makeJobs(5), { 'liveness.maxUrls': 2 });
    const result = (await search(controller, { liveness: 'true' })) as { jobs: JobPostDto[] };

    expect(probed).toEqual([['https://example.com/jobs/0', 'https://example.com/jobs/1']]);
    expect(result.jobs.map((j) => j.liveness?.state ?? null)).toEqual(['active', 'active', null, null, null]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('probing 2 of 5'));
  });

  it('the default cap (100) leaves a paginated page untouched', async () => {
    const { controller, probed } = createController(makeJobs(500));
    await search(controller, { liveness: 'true', paginate: 'true', page: '1', pageSize: '100' });
    expect(probed[0]).toHaveLength(100);
  });

  it('the default cap bounds an unpaginated request to 100 probes', async () => {
    const { controller, probed } = createController(makeJobs(250));
    const result = (await search(controller, { liveness: 'true' })) as { jobs: JobPostDto[] };
    expect(probed[0]).toHaveLength(100);
    expect(result.jobs.filter((j) => j.liveness).length).toBe(100);
  });

  it('maxUrls=0 means no cap', async () => {
    const { controller, probed } = createController(makeJobs(250), { 'liveness.maxUrls': 0 });
    await search(controller, { liveness: 'true' });
    expect(probed[0]).toHaveLength(250);
  });

  it('CSV honours the gate: no liveness columns when disabled', async () => {
    const { controller, liveness } = createController(makeJobs(2), { 'liveness.enabled': false });
    const res = { setHeader: jest.fn() };
    const file = (await search(controller, { format: 'csv', liveness: 'true' }, res)) as StreamableFile;
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
    const csv = Buffer.concat(chunks).toString('utf8');
    expect(liveness.checkBatch).not.toHaveBeenCalled();
    expect(csv.split('\n')[0]).not.toContain('liveness');
  });
});
