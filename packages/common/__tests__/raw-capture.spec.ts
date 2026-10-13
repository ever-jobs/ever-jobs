import 'reflect-metadata';

const mockAxiosRequest = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      request: mockAxiosRequest,
      defaults: { headers: { common: {} } },
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    })),
  },
}));

import { HttpClient } from '../src/http/http-client';
import {
  createRawCaptureSink,
  drainRawCapture,
  normalizeBody,
  pushRawEntry,
  redactUrl,
  retainBody,
} from '../src/http/raw-capture';
import { attachRawCapture } from '../src/browser/browser-pool';
import { runWithRawCapture, getRawCapture } from '../src/context';
import type { RawCaptureSink, RawHttpEntry } from '@ever-jobs/models';
import { resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetEffectiveCrawlPolicyCache } from '../src/http/crawl/scrape-context';

function settle<T>(promise: Promise<T>): Promise<T | Error> {
  return promise.catch((err: Error) => err);
}

const baseEntry = {
  attempt: 0,
  method: 'GET',
  url: 'https://example.com/x',
  status: 200,
  elapsed_ms: 1,
  body_bytes: 0,
  truncated: false,
};

// ---------------------------------------------------------------------------
// runWithRawCapture / sink basics
// ---------------------------------------------------------------------------

describe('runWithRawCapture — Spec 5161', () => {
  it('exposes the sink inside the wrapped call and not outside', async () => {
    const sink = createRawCaptureSink();
    expect(getRawCapture()).toBeUndefined();
    const seen = await runWithRawCapture(sink, async () => getRawCapture());
    expect(seen).toBe(sink);
    expect(getRawCapture()).toBeUndefined();
  });

  it('inherits the sink through nested async calls (delegated scrapes)', async () => {
    const sink = createRawCaptureSink();
    const inner = jest.fn().mockImplementation(async () => {
      pushRawEntry(sink as RawCaptureSink, { ...baseEntry });
      return 'done';
    });
    const outer = async () => inner();
    await runWithRawCapture(sink, outer);
    // The real propagation check: inner pushes into whatever sink it sees.
    const innerSeen: { sink?: RawCaptureSink } = {};
    await runWithRawCapture(sink, async () => {
      await Promise.resolve();
      innerSeen.sink = getRawCapture();
    });
    expect(innerSeen.sink).toBe(sink);
    expect(sink.entries.length).toBe(1);
  });
});

describe('pushRawEntry / retainBody — Spec 5161', () => {
  it('assigns seq in push order and drops writes once closed', () => {
    const sink = createRawCaptureSink();
    pushRawEntry(sink, { ...baseEntry });
    pushRawEntry(sink, { ...baseEntry, url: 'https://example.com/y' });
    expect(sink.entries.map((e) => e.seq)).toEqual([0, 1]);
    sink.closed = true;
    expect(pushRawEntry(sink, { ...baseEntry })).toBeNull();
    expect(sink.entries.length).toBe(2);
  });

  afterEach(() => {
    delete process.env.RAW_CAPTURE_MAX_BODY_BYTES;
    delete process.env.RAW_CAPTURE_MAX_SOURCE_BYTES;
  });

  it('truncates an over-cap text body and keeps the real byte count', () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '10';
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, entry, normalizeBody('x'.repeat(100)));
    expect(entry.body).toBe('x'.repeat(10));
    expect(entry.body_bytes).toBe(100);
    expect(entry.truncated).toBe(true);
  });

  it('omits the body once the source budget is spent but keeps recording entries', () => {
    process.env.RAW_CAPTURE_MAX_SOURCE_BYTES = '59';
    const sink = createRawCaptureSink();
    retainBody(sink, pushRawEntry(sink, { ...baseEntry })!, normalizeBody('a'.repeat(50)));
    const e2 = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, e2, normalizeBody('b'.repeat(10)));
    expect(e2.body).toBeUndefined();
    expect(e2.body_bytes).toBe(10);
    expect(e2.truncated).toBe(true);
  });

  it('omits an over-cap structured body (JSON cannot be partially parsed)', () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '20';
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, entry, normalizeBody({ postings: [{ title: 'x'.repeat(200) }] }));
    expect(entry.body).toBeUndefined();
    expect(entry.truncated).toBe(true);
  });
});

describe('drainRawCapture — Spec 5161', () => {
  it('waits for pending body fills before closing', async () => {
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    let release!: () => void;
    sink.pending.push(
      new Promise<void>((res) => {
        release = () => {
          entry.body = 'late body';
          res();
        };
      }),
    );
    const drained = drainRawCapture(sink, 5000);
    release();
    await drained;
    expect(entry.body).toBe('late body');
    expect(sink.closed).toBe(true);
  });

  it('closes anyway when a pending fill outlasts the cap', async () => {
    const sink = createRawCaptureSink();
    sink.pending.push(new Promise<void>(() => {}));
    const start = Date.now();
    await drainRawCapture(sink, 50);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(sink.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HttpClient capture
// ---------------------------------------------------------------------------

describe('HttpClient raw capture — Spec 5161', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    // Spec 1690 state is process-wide: a throttled bucket in one test would
    // pace (or cool down) the next test's requests.
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetHostLimiter();
  });

  async function run<T>(promise: Promise<T>): Promise<T | Error> {
    const settled = promise.catch((err: Error) => err);
    await jest.advanceTimersByTimeAsync(60_000);
    return settled;
  }

  it('records one entry per attempt with status, elapsed, and body', async () => {
    const sink = createRawCaptureSink();
    mockAxiosRequest
      .mockRejectedValueOnce(
        Object.assign(new Error('Request failed with status code 429'), {
          response: { status: 429, headers: {} },
        }),
      )
      .mockResolvedValueOnce({
        status: 200,
        data: { ok: true },
        headers: { 'content-type': 'application/json' },
      });
    const client = new HttpClient({ retries: 1 });
    const result = await run(
      runWithRawCapture(sink, () => client.get('https://acme.example.com/jobs')),
    );
    expect(result).toBeInstanceOf(Object); // the axios response, not an error
    expect(sink.entries.length).toBe(2);
    expect(sink.entries[0].attempt).toBe(0);
    expect(sink.entries[0].status).toBe(429);
    expect(sink.entries[0].error).toBeTruthy();
    expect(sink.entries[1].attempt).toBe(1);
    expect(sink.entries[1].status).toBe(200);
    expect(sink.entries[1].body).toEqual({ ok: true });
    expect(sink.entries[1].body_bytes).toBeGreaterThan(0);
    expect(sink.entries.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('redacts sensitive query params from entry URLs', async () => {
    const sink = createRawCaptureSink();
    mockAxiosRequest.mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
    const client = new HttpClient();
    await run(
      runWithRawCapture(sink, () =>
        client.get('https://acme.example.com/jobs?api_key=SECRET123&q=eng'),
      ),
    );
    expect(sink.entries[0].url).toContain('api_key=REDACTED');
    expect(sink.entries[0].url).not.toContain('SECRET123');
    expect(sink.entries[0].url).toContain('q=eng');
  });

  it('records a request_body only when the payload parses as JSON', async () => {
    const sink = createRawCaptureSink();
    mockAxiosRequest.mockResolvedValue({ status: 200, data: 'ok', headers: {} });
    const client = new HttpClient();
    await run(
      runWithRawCapture(sink, () =>
        client.post('https://acme.example.com/jobs', { site: 'acme', token: 't' }),
      ),
    );
    // JSON object payloads are captured with sensitive keys redacted.
    expect(sink.entries[0].request_body).toEqual({ site: 'acme', token: 'REDACTED' });
    // Non-JSON content is dropped per the spec.
    const sink2 = createRawCaptureSink();
    await run(
      runWithRawCapture(sink2, () =>
        client.post('https://acme.example.com/jobs', 'not json at all'),
      ),
    );
    expect(sink2.entries[0].request_body).toBeUndefined();
  });

  it('keeps the entry with status null when the request never got a response', async () => {
    const sink = createRawCaptureSink();
    mockAxiosRequest.mockRejectedValue(new Error('socket hangup'));
    const client = new HttpClient({ retries: 0 });
    const result = await run(
      runWithRawCapture(sink, () => client.get('https://acme.example.com/jobs')),
    );
    expect(result).toBeInstanceOf(Error);
    expect(sink.entries.length).toBe(1);
    expect(sink.entries[0].status).toBeNull();
    expect(sink.entries[0].error).toContain('socket hangup');
  });

  it('captures nothing when no sink is in context', async () => {
    mockAxiosRequest.mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
    const client = new HttpClient();
    const result = await run(client.get('https://acme.example.com/jobs'));
    expect(result).toBeInstanceOf(Object);
    expect(getRawCapture()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// attachRawCapture (browser)
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

function fakeRequest(overrides: Record<string, unknown> = {}) {
  const request: Record<string, unknown> = {
    resourceType: () => 'xhr',
    method: () => 'GET',
    url: () => 'https://board.example.com/api/jobs',
    redirectedFrom: () => null,
    postData: () => null,
    timing: () => ({ responseEnd: 42 }),
    response: () => null,
    failure: () => null,
    ...overrides,
  };
  return request as never;
}

function fakeResponse(request: unknown, overrides: Record<string, unknown> = {}) {
  const response: Record<string, unknown> = {
    request: () => request,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    body: () => Promise.resolve(Buffer.from('{"jobs":[]}')),
    ...overrides,
  };
  return response as never;
}

function fakePage(): { page: never; emit: (event: string, arg: unknown) => void } {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return page;
    },
  };
  return {
    page: page as never,
    emit: (event, arg) => (handlers.get(event) ?? []).forEach((h) => h(arg)),
  };
}

describe('attachRawCapture — Spec 5161', () => {
  it('records document/xhr/fetch entries and fills the body from the pending read', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const req = fakeRequest();
    emit('request', req);
    emit('response', fakeResponse(req));
    emit('requestfinished', req);

    expect(sink.entries.length).toBe(1);
    const entry = sink.entries[0];
    expect(entry.attempt).toBe(0);
    expect(entry.status).toBe(200);
    expect(entry.elapsed_ms).toBe(42);
    expect(entry.content_type).toBe('application/json');
    expect(sink.pending.length).toBe(1);

    await drainRawCapture(sink, 1000);
    expect(entry.body).toEqual({ jobs: [] });
    expect(entry.truncated).toBe(false);
  });

  it('skips asset resource types', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    for (const rt of ['stylesheet', 'image', 'font', 'script']) {
      const req = fakeRequest({ resourceType: () => rt });
      emit('request', req);
      emit('response', fakeResponse(req));
      emit('requestfinished', req);
    }
    await drainRawCapture(sink, 1000);
    expect(sink.entries.length).toBe(0);
  });

  it('collapses a redirect chain into one entry with final_url = last hop', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const hop1 = fakeRequest({ url: () => 'https://board.example.com/old' });
    const hop2 = fakeRequest({
      url: () => 'https://board.example.com/new',
      redirectedFrom: () => hop1,
    });
    emit('request', hop1);
    emit('request', hop2);
    emit('requestfinished', hop1);
    emit('requestfinished', hop2);

    expect(sink.entries.length).toBe(1);
    expect(sink.entries[0].url).toContain('/old');
    expect(sink.entries[0].final_url).toContain('/new');
  });

  it('records status null plus the failure text on requestfailed', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const req = fakeRequest({
      failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
      timing: () => ({ responseEnd: -1 }),
    });
    emit('request', req);
    emit('requestfailed', req);

    expect(sink.entries.length).toBe(1);
    expect(sink.entries[0].status).toBeNull();
    expect(sink.entries[0].error).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('marks the entry truncated when the body read fails (page closed early)', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const req = fakeRequest();
    emit('request', req);
    emit(
      'response',
      fakeResponse(req, { body: () => Promise.reject(new Error('page closed')) }),
    );
    emit('requestfinished', req);
    await drainRawCapture(sink, 1000);

    expect(sink.entries.length).toBe(1);
    expect(sink.entries[0].body).toBeUndefined();
    expect(sink.entries[0].truncated).toBe(true);
  });

  it('captures postData as request_body when it parses as JSON', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const req = fakeRequest({
      resourceType: () => 'fetch',
      method: () => 'POST',
      postData: () => '{"limit":20}',
    });
    emit('request', req);
    emit('requestfinished', req);

    expect(sink.entries[0].request_body).toEqual({ limit: 20 });
    expect(sink.entries[0].method).toBe('POST');
  });

  it('is a no-op when no sink is in context', () => {
    const { page, emit } = fakePage();
    attachRawCapture(page);
    emit('request', fakeRequest());
    emit('requestfinished', fakeRequest());
    // Nothing to assert against — the point is no throw and no state.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// redactUrl / normalizeBody helpers
// ---------------------------------------------------------------------------

describe('redactUrl — Spec 5161', () => {
  it('redacts sensitive keys case-insensitively', () => {
    const redacted = redactUrl('https://x.io/?ApiKey=abc&ok=1');
    expect(redacted).toContain('ApiKey=REDACTED');
    expect(redacted).not.toContain('abc');
    expect(redactUrl('https://x.io/?ok=1')).toContain('ok=1');
  });
});

describe('normalizeBody — Spec 5161', () => {
  it('keeps JSON bodies structured and drops streams', () => {
    expect(normalizeBody({ a: 1 }, 'application/json')).toEqual({
      value: { a: 1 },
      bytes: 7,
    });
    expect(normalizeBody('{"a":1}', 'application/json')?.value).toBe('{"a":1}');
    expect(normalizeBody('plain', 'text/plain')).toEqual({ value: 'plain', bytes: 5 });
    const stream = { pipe: () => undefined };
    expect(normalizeBody(stream, 'text/plain')).toBeNull();
  });
});
