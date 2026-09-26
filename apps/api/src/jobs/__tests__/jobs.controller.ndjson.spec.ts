import 'reflect-metadata';
import { EventEmitter } from 'events';
import { BadRequestException, StreamableFile } from '@nestjs/common';
import { JobPostDto, LocationDto, ScraperInputDto } from '@ever-jobs/models';
import { JobsController } from '../jobs.controller';
import { NDJSON_CONTENT_TYPE, NDJSON_HEARTBEAT_MS } from '../ndjson-writer';
import type { SearchProgress, SearchRunOptions } from '../search-input';
import { COMPLETE_SEARCH, type SearchCompleteness } from '../search-completeness';
import { SEARCH_CACHE_ENDPOINT } from '../search-cache';

/**
 * Spec 1721 — `POST /api/jobs/search?format=ndjson`.
 *
 * The controller is constructed directly (as in `jobs.controller.spec.ts`)
 * and the returned `StreamableFile` is read to the end, so every assertion is
 * about the exact bytes a client would receive.
 */

type Line = { type: string; [key: string]: unknown };

function makeJob(i: number, extra: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({
    id: `job-${i}`,
    title: `Engineer ${i}`,
    companyName: 'Acme',
    jobUrl: `https://example.com/jobs/${i}`,
    location: new LocationDto({ city: 'Berlin', country: 'GERMANY' }),
    datePosted: '2026-09-01',
    site: 'linkedin',
    dedupKey: `key-${i}`,
    ...extra,
  });
}

interface Harness {
  controller: JobsController;
  jobsService: { searchJobsWithDiagnostics: jest.Mock; searchJobs: jest.Mock; assertSearchable: jest.Mock };
  aggregator: { aggregateRaw: jest.Mock };
  cacheService: { get: jest.Mock; set: jest.Mock };
  liveness: { checkBatch: jest.Mock; check: jest.Mock };
}

function createHarness(opts: {
  jobs?: JobPostDto[];
  cached?: JobPostDto[] | null;
  /** Spec 1721 / FR-15, FR-19 — the completeness record stored in the same entry as `cached` (absent: none). */
  cachedCompleteness?: unknown;
  /** What the default fan-out reports; `null` = a service that reports none. */
  completeness?: SearchCompleteness | null;
  search?: (input: ScraperInputDto, options?: SearchRunOptions) => Promise<unknown>;
  config?: Record<string, unknown>;
  deduped?: boolean;
  assertSearchable?: (input: ScraperInputDto) => void;
} = {}): Harness {
  const jobs = opts.jobs ?? [makeJob(1), makeJob(2), makeJob(3)];
  const jobsService = {
    searchJobs: jest.fn(),
    assertSearchable: jest.fn(opts.assertSearchable ?? (() => undefined)),
    searchJobsWithDiagnostics: jest.fn(
      opts.search ??
        (async (_input: ScraperInputDto, options?: { onProgress?: (p: SearchProgress) => void }) => {
          options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 2, jobs: 0 });
          options?.onProgress?.({ sourcesDone: 1, sourcesTotal: 2, jobs: jobs.length });
          options?.onProgress?.({ sourcesDone: 2, sourcesTotal: 2, jobs: jobs.length });
          const completeness = opts.completeness === undefined ? { ...COMPLETE_SEARCH } : opts.completeness;
          return completeness ? { jobs, perSource: [], completeness } : { jobs, perSource: [] };
        }),
    ),
  };
  const aggregator = {
    aggregateRaw: jest.fn(async (raw: JobPostDto[]) => ({
      jobs: raw,
      rawCount: raw.length,
      outputCount: raw.length,
      deduped: opts.deduped ?? true,
    })),
  };
  const cacheService = {
    // FR-19 — one entry: `{ jobs, completeness? }` under endpoint `search-v2`.
    get: jest.fn(async (params: { endpoint?: string }) =>
      params.endpoint === SEARCH_CACHE_ENDPOINT && opts.cached
        ? {
            jobs: opts.cached,
            ...(opts.cachedCompleteness !== undefined ? { completeness: opts.cachedCompleteness } : {}),
          }
        : null,
    ),
    set: jest.fn(async () => undefined),
  };
  const config = opts.config ?? {};
  const configService = {
    get: (key: string, def?: unknown) => (key in config ? config[key] : def),
  };
  const liveness = {
    check: jest.fn(),
    checkBatch: jest.fn(async (urls: string[]) =>
      urls.map((url) => ({ url, result: 'active', code: 'ok', checkedAt: '2026-09-24T00:00:00Z' })),
    ),
  };
  const controller = new JobsController(
    jobsService as any,
    aggregator as any,
    {} as any,
    cacheService as any,
    configService as any,
    liveness as any,
  );
  return { controller, jobsService, aggregator, cacheService, liveness };
}

class FakeResponse extends EventEmitter {
  headers: Record<string, string> = {};
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
}

/** Positional call helper — the controller's parameter list, NDJSON flavour. */
async function callNdjson(
  controller: JobsController,
  input: ScraperInputDto,
  q: { paginate?: string; page?: string; pageSize?: string; dedup?: string; liveness?: string; legitimacy?: string } = {},
  res: FakeResponse = new FakeResponse(),
): Promise<{ file: StreamableFile; res: FakeResponse }> {
  const file = (await controller.searchJobs(
    input,
    'ndjson',
    q.paginate,
    q.page,
    q.pageSize,
    q.dedup,
    q.liveness,
    q.legitimacy,
    res as any,
  )) as StreamableFile;
  return { file, res };
}

async function readAll(file: StreamableFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function parseLines(body: string): Line[] {
  expect(body.endsWith('\n')).toBe(true);
  return body
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line);
}

describe('JobsController — NDJSON stream (Spec 1721)', () => {
  it('sets the NDJSON headers and returns a StreamableFile', async () => {
    const { controller } = createHarness();
    const { file, res } = await callNdjson(controller, new ScraperInputDto({}));
    expect(file).toBeInstanceOf(StreamableFile);
    expect(res.headers['content-type']).toBe(NDJSON_CONTENT_TYPE);
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
    await readAll(file);
  });

  it('emits progress first, then one job line per job, then exactly one end line', async () => {
    const jobs = [makeJob(1), makeJob(2), makeJob(3)];
    const { controller } = createHarness({ jobs, deduped: true });

    const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));

    // Spec 1721 / FR-12 — the synchronous first line, then the fan-out start.
    expect(lines[0]).toEqual({ type: 'progress', sourcesDone: 0, sourcesTotal: 0, jobs: 0 });
    expect(lines[1]).toEqual({ type: 'progress', sourcesDone: 0, sourcesTotal: 2, jobs: 0 });
    const types = lines.map((l) => l.type);
    const firstJob = types.indexOf('job');
    expect(types.slice(0, firstJob).every((t) => t === 'progress')).toBe(true);
    expect(types.slice(firstJob, firstJob + 3)).toEqual(['job', 'job', 'job']);
    expect(types.filter((t) => t === 'end')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('end');

    const end = lines[lines.length - 1]!;
    expect(end).toMatchObject({ type: 'end', total: 3, deduped: true });
    expect(typeof end.durationMs).toBe('number');
    expect(end.durationMs as number).toBeGreaterThanOrEqual(0);
    // Spec 1721 / FR-15, FR-20 — the crawl-completeness fields are part of every end line.
    expect(end).toMatchObject({ complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0, sourcesPartial: 0, problemSources: [], problemSourcesTotal: 0 });
    expect(Object.keys(end).sort()).toEqual([
      'complete',
      'deduped',
      'durationMs',
      'problemSources',
      'problemSourcesTotal',
      'sourcesFailed',
      'sourcesPartial',
      'sourcesSkipped',
      'stopReason',
      'total',
      'type',
    ]);
  });

  it('each job line carries exactly the per-job JSON of the JSON response, in the same order', async () => {
    const jobs = [makeJob(1), makeJob(2, { compensation: { minAmount: 1, maxAmount: 2 } as any }), makeJob(3)];

    const json = createHarness({ jobs });
    const jsonResult = (await json.controller.searchJobs(new ScraperInputDto({}))) as { jobs: JobPostDto[] };
    const jsonJobs = JSON.parse(JSON.stringify(jsonResult.jobs));

    const nd = createHarness({ jobs });
    const lines = parseLines(await readAll((await callNdjson(nd.controller, new ScraperInputDto({}))).file));
    const streamed = lines.filter((l) => l.type === 'job').map((l) => l.data);

    expect(streamed).toEqual(jsonJobs);
    expect(streamed.map((j: any) => j.id)).toEqual(['job-1', 'job-2', 'job-3']);
    // Every job line is exactly {type, data} — nothing else leaks in.
    for (const line of lines.filter((l) => l.type === 'job')) {
      expect(Object.keys(line).sort()).toEqual(['data', 'type']);
    }
  });

  it('passes extra job fields (e.g. careerLevel from another feature) through untouched', async () => {
    const careerLevel = { level: 'senior', confidence: 'high', reasons: ['title: Senior'] };
    const job = makeJob(1, { title: 'Senior Engineer' });
    Object.assign(job, { careerLevel, someFutureField: { nested: [1, 2] } });
    const { controller } = createHarness({ jobs: [job] });

    const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));
    const data = lines.find((l) => l.type === 'job')!.data as Record<string, unknown>;
    expect(data.careerLevel).toEqual(careerLevel);
    expect(data.someFutureField).toEqual({ nested: [1, 2] });
    expect(data.dedupKey).toBe('key-1');
  });

  it('ignores paginate/page/page_size', async () => {
    const jobs = Array.from({ length: 7 }, (_, i) => makeJob(i));
    const { controller } = createHarness({ jobs });

    const lines = parseLines(
      await readAll(
        (await callNdjson(controller, new ScraperInputDto({}), { paginate: 'true', page: '2', pageSize: '2' })).file,
      ),
    );

    expect(lines.filter((l) => l.type === 'job')).toHaveLength(7);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'end', total: 7 });
  });

  it('passes the dedup flag through exactly as the JSON path does', async () => {
    const { controller, aggregator } = createHarness({ deduped: false });
    const lines = parseLines(
      await readAll((await callNdjson(controller, new ScraperInputDto({}), { dedup: 'false' })).file),
    );
    expect(aggregator.aggregateRaw).toHaveBeenCalledWith(expect.any(Array), {
      dedup: false,
      persist: true,
      deferCareerLevel: true,
    });
    expect(lines[lines.length - 1]).toMatchObject({ type: 'end', deduped: false });
  });

  it('passes the careerLevels filter to the aggregator, exactly as the JSON path does (Spec 1730)', async () => {
    const { controller, aggregator } = createHarness();
    await readAll(
      (await callNdjson(controller, new ScraperInputDto({ careerLevels: ['internship', 'new_grad'] }))).file,
    );
    // The exact options object: a call rebuilt as { dedup, persist } would stream the
    // unfiltered set (the filter reaches the aggregator only through these options).
    expect(aggregator.aggregateRaw).toHaveBeenCalledTimes(1);
    expect(aggregator.aggregateRaw.mock.calls[0]![1]).toStrictEqual({
      dedup: true,
      persist: true,
      careerLevels: ['internship', 'new_grad'],
      deferCareerLevel: true,
    });
  });

  it('keeps careerLevels out of the search cache key (Spec 1730; the single FR-19 entry)', async () => {
    const { controller, cacheService } = createHarness();
    await readAll(
      (await callNdjson(controller, new ScraperInputDto({ searchTerm: 'go', careerLevels: ['senior'] }))).file,
    );
    await readAll((await callNdjson(controller, new ScraperInputDto({ searchTerm: 'go' }))).file);

    const gets = cacheService.get.mock.calls.map(([key]) => key as Record<string, unknown>);
    const sets = cacheService.set.mock.calls.map(([key]) => key as unknown as Record<string, unknown>);
    // Each stream: one lookup of the search entry (a miss), then one write of that entry, which
    // holds the raw set and its completeness record together.
    expect(gets).toHaveLength(2);
    expect(sets).toHaveLength(2);
    for (const key of [...gets, ...sets]) {
      expect(key.careerLevels).toBeUndefined();
      expect(key.searchTerm).toBe('go');
      expect(key.endpoint).toBe(SEARCH_CACHE_ENDPOINT);
    }
    // The filtered and the unfiltered search share the entry.
    expect(gets[0]).toEqual(gets[1]);
    expect(sets[0]).toEqual(gets[0]);
    expect(sets[1]).toEqual(sets[0]);
  });

  it('filters a cache hit per stream: careerLevels reaches the aggregator without a fan-out (Spec 1730)', async () => {
    const cached = [makeJob(1), makeJob(2)];
    const { controller, jobsService, aggregator } = createHarness({
      cached,
      cachedCompleteness: { ...COMPLETE_SEARCH },
    });
    const lines = parseLines(
      await readAll((await callNdjson(controller, new ScraperInputDto({ careerLevels: ['executive'] }))).file),
    );
    expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
    expect(aggregator.aggregateRaw).toHaveBeenCalledWith(cached, {
      dedup: true,
      persist: true,
      careerLevels: ['executive'],
      deferCareerLevel: true,
    });
    expect(lines[lines.length - 1]).toMatchObject({ type: 'end', complete: true });
  });

  it('a failure after headers writes an error line and NO end line', async () => {
    const { controller } = createHarness({
      search: async (_input, options) => {
        options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 5, jobs: 0 });
        throw new Error('fan-out exploded');
      },
    });

    const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));

    expect(lines).toEqual([
      { type: 'progress', sourcesDone: 0, sourcesTotal: 0, jobs: 0 },
      { type: 'progress', sourcesDone: 0, sourcesTotal: 5, jobs: 0 },
      { type: 'error', message: 'fan-out exploded' },
    ]);
  });

  it('a failure while serialising a job ends with an error line, not an end line', async () => {
    const circular = makeJob(2) as any;
    circular.self = circular;
    const { controller } = createHarness({ jobs: [makeJob(1), circular] });

    const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));
    const types = lines.map((l) => l.type);
    expect(types.filter((t) => t === 'job')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('error');
    expect(types).not.toContain('end');
  });

  it('streams a cache hit without running the fan-out', async () => {
    const cached = [makeJob(9)];
    const { controller, jobsService } = createHarness({ cached, cachedCompleteness: { ...COMPLETE_SEARCH } });

    const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));

    expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
    // Spec 1721 / FR-12 — a cache hit also starts with a progress line (it
    // used to start with the first job line, i.e. only after dedup/persist).
    expect(lines.map((l) => l.type)).toEqual(['progress', 'job', 'end']);
    expect(lines[0]).toEqual({ type: 'progress', sourcesDone: 0, sourcesTotal: 0, jobs: 0 });
    expect(lines[2]).toMatchObject({ total: 1 });
  });

  it('on a cache hit the first line is readable while dedup/persistence is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = createHarness({ cached: [makeJob(9)], cachedCompleteness: { ...COMPLETE_SEARCH } });
    harness.aggregator.aggregateRaw.mockImplementation(async (raw: JobPostDto[]) => {
      await gate;
      return { jobs: raw, rawCount: raw.length, outputCount: raw.length, deduped: true };
    });

    const { file } = await callNdjson(harness.controller, new ScraperInputDto({}));
    const stream = file.getStream();
    const first = await new Promise<Buffer>((resolve) =>
      stream.once('data', (chunk: Buffer) => {
        stream.pause(); // nothing may be emitted before the loop below listens
        resolve(chunk);
      }),
    );
    expect(JSON.parse(first.toString('utf8').split('\n')[0]!)).toEqual({
      type: 'progress',
      sourcesDone: 0,
      sourcesTotal: 0,
      jobs: 0,
    });
    expect(harness.aggregator.aggregateRaw).toHaveBeenCalledTimes(1); // still pending

    release();
    const rest: Buffer[] = [];
    for await (const chunk of stream) rest.push(Buffer.from(chunk as Buffer));
    expect(parseLines(Buffer.concat(rest).toString('utf8')).map((l) => l.type)).toEqual(['job', 'end']);
  });

  it('input the search would reject is a 400 before any stream exists (FR-13)', async () => {
    const harness = createHarness({
      assertSearchable: () => {
        throw new BadRequestException('domain `nope.example` → token `nope_example` is not a registered plugin');
      },
    });
    const res = new FakeResponse();

    await expect(
      harness.controller.searchJobs(
        new ScraperInputDto({ companyDomain: ['nope.example'] }),
        'ndjson',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        res as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(harness.jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
    expect(harness.cacheService.get).not.toHaveBeenCalled();
    expect(res.headers['content-type']).toBeUndefined();
  });

  it('a disconnect stops the fan-out from starting sources and the partial result is not cached or deduped (FR-14)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: boolean[] = [];
    const harness = createHarness({
      search: async (_input, options) => {
        options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 3, jobs: 0 });
        seen.push(options!.isCancelled!());
        await gate;
        seen.push(options!.isCancelled!());
        return { jobs: [makeJob(1)], perSource: [], cancelled: true };
      },
    });
    const res = new FakeResponse();
    const { file } = await callNdjson(harness.controller, new ScraperInputDto({}), {}, res);
    const stream = file.getStream();

    res.emit('close');
    release();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([false, true]);
    expect(harness.cacheService.set).not.toHaveBeenCalled();
    expect(harness.aggregator.aggregateRaw).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });

  it('a client that left during the fan-out triggers no liveness probes (PR #101 review)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = createHarness({
      search: async (_input, options) => {
        options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 1, jobs: 0 });
        await gate;
        return { jobs: [makeJob(1), makeJob(2)], perSource: [] };
      },
    });
    const res = new FakeResponse();
    await callNdjson(harness.controller, new ScraperInputDto({}), { liveness: 'true' }, res);

    res.emit('close');
    release();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    // The complete set is still aggregated (and cached, see below); no URL is probed for nobody.
    expect(harness.aggregator.aggregateRaw).toHaveBeenCalled();
    expect(harness.liveness.checkBatch).not.toHaveBeenCalled();
  });

  it('control: a client that stays gets its liveness probes', async () => {
    const harness = createHarness();
    const { file } = await callNdjson(harness.controller, new ScraperInputDto({}), { liveness: 'true' });
    await readAll(file);
    expect(harness.liveness.checkBatch).toHaveBeenCalledTimes(1);
  });

  it('a complete fan-out whose client left is still cached (a retry gets the whole set)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = createHarness({
      search: async (_input, options) => {
        options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 1, jobs: 0 });
        await gate;
        return { jobs: [makeJob(1)], perSource: [] };
      },
    });
    const res = new FakeResponse();
    await callNdjson(harness.controller, new ScraperInputDto({}), {}, res);

    res.emit('close');
    release();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    // One entry: the raw set (and, when the service reports one, its completeness record).
    expect(harness.cacheService.set).toHaveBeenCalledWith(expect.objectContaining({ endpoint: SEARCH_CACHE_ENDPOINT }), {
      jobs: [expect.objectContaining({ id: 'job-1' })],
    });
  });

  it('uses the same cache key as the JSON path and writes the raw fan-out to it', async () => {
    const { controller, cacheService } = createHarness();
    await readAll((await callNdjson(controller, new ScraperInputDto({ searchTerm: 'go' }))).file);
    expect(cacheService.get).toHaveBeenCalledWith(
      expect.objectContaining({ searchTerm: 'go', endpoint: SEARCH_CACHE_ENDPOINT }),
    );
    // ONE entry: the raw fan-out and its completeness record (Spec 1721 / FR-19).
    expect(cacheService.set).toHaveBeenCalledTimes(1);
    const [key, value] = cacheService.set.mock.calls[0] as unknown as [Record<string, unknown>, { jobs: unknown[]; completeness: unknown }];
    expect(key).toMatchObject({ searchTerm: 'go', endpoint: SEARCH_CACHE_ENDPOINT });
    expect(value.jobs).toHaveLength(3);
    expect(value.completeness).toEqual(COMPLETE_SEARCH);
  });

  it('the first line is readable while the fan-out is still running (headers flush immediately)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { controller } = createHarness({
      search: async (_input, options) => {
        options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 1669, jobs: 0 });
        await gate;
        return { jobs: [makeJob(1)], perSource: [] };
      },
    });

    // The handler resolves BEFORE the fan-out does.
    const { file } = await callNdjson(controller, new ScraperInputDto({}));
    const stream = file.getStream();
    const chunks: Buffer[] = [];
    // Pause after the first chunk so nothing is emitted before the loop below listens.
    chunks.push(
      await new Promise<Buffer>((resolve) =>
        stream.once('data', (chunk: Buffer) => {
          stream.pause();
          resolve(chunk);
        }),
      ),
    );
    expect(JSON.parse(chunks[0]!.toString('utf8').split('\n')[0]!)).toEqual({
      type: 'progress',
      sourcesDone: 0,
      sourcesTotal: 0,
      jobs: 0,
    });

    release();
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    const lines = parseLines(Buffer.concat(chunks).toString('utf8'));
    expect(lines.map((l) => l.type)).toEqual(['progress', 'progress', 'job', 'end']);
    expect(lines[1]).toEqual({ type: 'progress', sourcesDone: 0, sourcesTotal: 1669, jobs: 0 });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('re-emits the latest progress every NDJSON_HEARTBEAT_MS while scraping, then stops', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let report!: (p: SearchProgress) => void;
      const { controller } = createHarness({
        search: async (_input, options) => {
          report = options!.onProgress!;
          report({ sourcesDone: 0, sourcesTotal: 10, jobs: 0 });
          await gate;
          return { jobs: [makeJob(1)], perSource: [] };
        },
      });

      const { file } = await callNdjson(controller, new ScraperInputDto({}));
      const body = readAll(file);

      // Progress inside one interval is coalesced: no extra line yet.
      report({ sourcesDone: 3, sourcesTotal: 10, jobs: 40 });
      await jest.advanceTimersByTimeAsync(NDJSON_HEARTBEAT_MS - 1);
      report({ sourcesDone: 4, sourcesTotal: 10, jobs: 55 });
      await jest.advanceTimersByTimeAsync(1);
      report({ sourcesDone: 9, sourcesTotal: 10, jobs: 90 });
      await jest.advanceTimersByTimeAsync(NDJSON_HEARTBEAT_MS);

      release();
      const lines = parseLines(await body);

      const progress = lines.filter((l) => l.type === 'progress');
      expect(progress).toEqual([
        { type: 'progress', sourcesDone: 0, sourcesTotal: 0, jobs: 0 },
        { type: 'progress', sourcesDone: 0, sourcesTotal: 10, jobs: 0 },
        { type: 'progress', sourcesDone: 4, sourcesTotal: 10, jobs: 55 },
        { type: 'progress', sourcesDone: 9, sourcesTotal: 10, jobs: 90 },
      ]);
      expect(lines.map((l) => l.type).slice(-2)).toEqual(['job', 'end']);

      // After the end line the timer is gone: nothing more is written.
      await jest.advanceTimersByTimeAsync(NDJSON_HEARTBEAT_MS * 3);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps heart-beating through a slow liveness phase, and never after the first job line', async () => {
      let releaseLiveness!: () => void;
      const livenessGate = new Promise<void>((resolve) => (releaseLiveness = resolve));
      const jobs = [makeJob(1), makeJob(2)];
      const harness = createHarness({ jobs });
      harness.liveness.checkBatch.mockImplementation(async (urls: string[]) => {
        await livenessGate;
        return urls.map((url) => ({ url, result: 'active', code: 'ok', checkedAt: 'x' }));
      });

      const { file } = await callNdjson(harness.controller, new ScraperInputDto({}), { liveness: 'true' });
      const body = readAll(file);
      await jest.advanceTimersByTimeAsync(NDJSON_HEARTBEAT_MS * 2);
      releaseLiveness();
      const lines = parseLines(await body);

      const types = lines.map((l) => l.type);
      // start line + two heartbeats while liveness was running
      expect(types.filter((t) => t === 'progress').length).toBeGreaterThanOrEqual(3);
      const firstJob = types.indexOf('job');
      expect(types.slice(firstJob)).toEqual(['job', 'job', 'end']);
    });
  });

  it('stops writing when the client disconnects (no throw, no end line)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { controller } = createHarness({
      jobs: [makeJob(1), makeJob(2)],
      search: async (_input, options) => {
        options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 1, jobs: 0 });
        await gate;
        return { jobs: [makeJob(1), makeJob(2)], perSource: [] };
      },
    });
    const res = new FakeResponse();
    const { file } = await callNdjson(controller, new ScraperInputDto({}), {}, res);
    const stream = file.getStream();

    res.emit('close');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stream.destroyed).toBe(true);
  });

  it('applies liveness only to the first EVER_JOBS_LIVENESS_MAX_URLS jobs', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => makeJob(i));
    const { controller, liveness } = createHarness({ jobs, config: { 'liveness.maxUrls': 2 } });

    const lines = parseLines(
      await readAll((await callNdjson(controller, new ScraperInputDto({}), { liveness: 'true' })).file),
    );

    expect(liveness.checkBatch).toHaveBeenCalledTimes(1);
    expect(liveness.checkBatch.mock.calls[0]![0]).toEqual([
      'https://example.com/jobs/0',
      'https://example.com/jobs/1',
    ]);
    const data = lines.filter((l) => l.type === 'job').map((l) => l.data as Record<string, unknown>);
    expect(data.map((d) => d.liveness !== undefined)).toEqual([true, true, false, false, false]);
  });

  it('never probes when the server gate is off, even with ?liveness=true', async () => {
    const { controller, liveness } = createHarness({ config: { 'liveness.enabled': false } });
    const lines = parseLines(
      await readAll((await callNdjson(controller, new ScraperInputDto({}), { liveness: 'true' })).file),
    );
    expect(liveness.checkBatch).not.toHaveBeenCalled();
    for (const line of lines.filter((l) => l.type === 'job')) {
      expect((line.data as Record<string, unknown>).liveness).toBeUndefined();
    }
  });

  describe('crawl completeness on the end line (FR-15)', () => {
    const endOf = (lines: Line[]): Line => {
      const end = lines[lines.length - 1]!;
      expect(end.type).toBe('end');
      return end;
    };

    it('a deadline-truncated crawl says so: complete=false, stopReason, skipped and failed counts', async () => {
      const { controller } = createHarness({
        completeness: {
          complete: false,
          stopReason: 'deadline',
          sourcesSkipped: 412,
          sourcesFailed: 9,
          sourcesPartial: 2,
          problemSources: [
            { site: 'indeed', reason: 'blocked' },
            { site: 'remoteok', reason: 'partial' },
            { site: 'glassdoor', reason: 'skipped' },
          ],
          problemSourcesTotal: 423,
        },
      });

      const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));
      const { durationMs, ...end } = endOf(lines);

      expect(typeof durationMs).toBe('number');
      expect(end).toEqual({
        type: 'end',
        total: 3,
        deduped: true,
        complete: false,
        stopReason: 'deadline',
        sourcesSkipped: 412,
        sourcesFailed: 9,
        // FR-20 — per-source detail, capped list plus the uncapped total.
        sourcesPartial: 2,
        problemSources: [
          { site: 'indeed', reason: 'blocked' },
          { site: 'remoteok', reason: 'partial' },
          { site: 'glassdoor', reason: 'skipped' },
        ],
        problemSourcesTotal: 423,
      });
      // The job lines are unchanged: completeness is only on the end line.
      expect(lines.filter((l) => l.type === 'job')).toHaveLength(3);
    });

    it('a crawl stopped by the job ceiling reports job_ceiling', async () => {
      const { controller } = createHarness({
        completeness: {
          complete: false,
          stopReason: 'job_ceiling',
          sourcesSkipped: 3,
          sourcesFailed: 0,
          sourcesPartial: 0, problemSources: [], problemSourcesTotal: 0,
        },
      });
      const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));
      expect(endOf(lines)).toMatchObject({ complete: false, stopReason: 'job_ceiling', sourcesSkipped: 3 });
    });

    it('failed sources alone do not make a crawl incomplete', async () => {
      const { controller } = createHarness({
        completeness: { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 17, sourcesPartial: 0, problemSources: [], problemSourcesTotal: 0 },
      });
      const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));
      expect(endOf(lines)).toMatchObject({ complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 17 });
    });

    it('a fresh fan-out caches its completeness in the same entry as the raw set (FR-19)', async () => {
      const completeness: SearchCompleteness = {
        complete: true,
        stopReason: null,
        sourcesSkipped: 0,
        sourcesFailed: 1,
        sourcesPartial: 0,
        problemSources: [{ site: 'indeed', reason: 'fetch_error' }],
        problemSourcesTotal: 1,
      };
      const { controller, cacheService } = createHarness({ completeness });

      await readAll((await callNdjson(controller, new ScraperInputDto({ searchTerm: 'rust', location: 'Berlin' }))).file);

      expect(cacheService.set).toHaveBeenCalledTimes(1);
      const [[key, value]] = cacheService.set.mock.calls as unknown as [
        [Record<string, unknown>, { jobs: unknown[]; completeness: unknown }],
      ];
      expect(key).toMatchObject({ searchTerm: 'rust', location: 'Berlin', endpoint: SEARCH_CACHE_ENDPOINT });
      expect(value.jobs).toHaveLength(3);
      expect(value.completeness).toEqual(completeness);
    });

    it.each([
      ['the deadline', 'deadline'],
      ['the job ceiling', 'job_ceiling'],
    ] as const)('an incomplete crawl (%s) is streamed but never cached (FR-20)', async (_label, stopReason) => {
      const { controller, cacheService } = createHarness({
        completeness: { complete: false, stopReason, sourcesSkipped: 4, sourcesFailed: 0, sourcesPartial: 0, problemSources: [], problemSourcesTotal: 0 },
      });

      const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));

      expect(endOf(lines)).toMatchObject({ total: 3, complete: false, stopReason });
      expect(cacheService.set).not.toHaveBeenCalled();
    });

    it('the JSON path does not cache an incomplete crawl either (FR-20)', async () => {
      const { controller, cacheService } = createHarness({
        completeness: { complete: false, stopReason: 'deadline', sourcesSkipped: 1, sourcesFailed: 0, sourcesPartial: 0, problemSources: [], problemSourcesTotal: 0 },
      });
      const result = (await controller.searchJobs(new ScraperInputDto({}))) as { count: number };
      expect(result.count).toBe(3);
      expect(cacheService.set).not.toHaveBeenCalled();
    });

    it('a cache hit reports the completeness of the crawl that produced it, without a fan-out', async () => {
      const record: SearchCompleteness = {
        complete: true,
        stopReason: null,
        sourcesSkipped: 0,
        sourcesFailed: 4,
        sourcesPartial: 1,
        problemSources: [{ site: 'remoteok', reason: 'partial' }],
        problemSourcesTotal: 5,
      };
      const { controller, jobsService, cacheService } = createHarness({
        cached: [makeJob(9)],
        cachedCompleteness: record,
      });

      const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));

      expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();
      expect(endOf(lines)).toMatchObject({ total: 1, ...record });
    });

    it.each([
      ['no completeness record (written before FR-15)', undefined],
      ['a malformed record', { complete: false, stopReason: 'cancelled', sourcesSkipped: 1, sourcesFailed: 0, sourcesPartial: 0, problemSources: [], problemSourcesTotal: 0 }],
      ['a pre-FR-20 record', { complete: true, stopReason: null, sourcesSkipped: 0, sourcesFailed: 0 }],
    ])('a cache hit with %s runs the fan-out instead of guessing', async (_label, cachedCompleteness) => {
      const fresh = [makeJob(1), makeJob(2)];
      const { controller, jobsService, cacheService } = createHarness({
        jobs: fresh,
        cached: [makeJob(9)],
        cachedCompleteness,
      });

      const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));

      expect(jobsService.searchJobsWithDiagnostics).toHaveBeenCalledTimes(1);
      expect(lines.filter((l) => l.type === 'job').map((l) => (l.data as { id: string }).id)).toEqual([
        'job-1',
        'job-2',
      ]);
      expect(endOf(lines)).toMatchObject({ total: 2, complete: true, stopReason: null });
      // The entry is rewritten with a record, so the next hit has one.
      expect(cacheService.set).toHaveBeenCalledTimes(1);
      expect(cacheService.set.mock.calls[0]![1]).toMatchObject({ completeness: COMPLETE_SEARCH });
    });

    it('the JSON path still serves a cache hit that has no completeness record', async () => {
      const { controller, jobsService, cacheService } = createHarness({ cached: [makeJob(9)] });

      const result = (await controller.searchJobs(new ScraperInputDto({}))) as { cached: boolean; count: number };

      expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
      expect(result).toMatchObject({ cached: true, count: 1 });
      // One read: the set and the record live in one entry (FR-19).
      expect(cacheService.get).toHaveBeenCalledTimes(1);
    });

    it('a service that reports no completeness gets the fields omitted, never guessed', async () => {
      const { controller } = createHarness({ completeness: null });

      const lines = parseLines(await readAll((await callNdjson(controller, new ScraperInputDto({}))).file));

      expect(Object.keys(endOf(lines)).sort()).toEqual(['deduped', 'durationMs', 'total', 'type']);
    });

    it('a cancelled fan-out still ends without an end line (completeness never reaches the client)', async () => {
      const harness = createHarness({
        search: async (_input, options) => {
          options?.onProgress?.({ sourcesDone: 0, sourcesTotal: 2, jobs: 0 });
          return {
            jobs: [makeJob(1)],
            perSource: [],
            completeness: { ...COMPLETE_SEARCH },
            cancelled: true,
          };
        },
      });

      const lines = parseLines(await readAll((await callNdjson(harness.controller, new ScraperInputDto({}))).file));

      expect(lines.map((l) => l.type)).not.toContain('end');
      expect(harness.cacheService.set).not.toHaveBeenCalled();
    });
  });
});
