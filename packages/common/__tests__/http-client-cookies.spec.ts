import 'reflect-metadata';
import { CookieJar } from 'tough-cookie';

const mockAxiosRequest = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => {
      const requestHandlers: Array<(config: any) => any> = [];
      const responseHandlers: Array<{ onFulfilled?: (response: any) => any; onRejected?: (error: any) => any }> = [];

      return {
        request: jest.fn(async (config: any) => {
          let cfg = config;
          for (const handler of requestHandlers) {
            cfg = await handler(cfg);
          }

          let response: any;
          let error: any;
          try {
            response = await mockAxiosRequest(cfg);
            response.config = cfg;
          } catch (e) {
            error = e;
            if (error?.response) {
              error.response.config = cfg;
            }
            for (const handler of responseHandlers) {
              if (handler.onRejected) {
                try {
                  await handler.onRejected(error);
                } catch (rethrown) {
                  error = rethrown;
                }
              }
            }
            throw error;
          }

          for (const handler of responseHandlers) {
            if (handler.onFulfilled) {
              response = handler.onFulfilled(response) ?? response;
            }
          }
          return response;
        }),
        defaults: { headers: { common: {} } },
        interceptors: {
          request: { use: jest.fn((handler: any) => requestHandlers.push(handler)) },
          response: { use: jest.fn((onFulfilled: any, onRejected: any) => responseHandlers.push({ onFulfilled, onRejected })) },
        },
      };
    }),
  },
}));

import { HttpClient, createHttpClient } from '../src/http/http-client';
import { EVER_JOBS_DEFAULT_USER_AGENT } from '../src/http/crawl/defaults';
import { resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetEffectiveCrawlPolicyCache } from '../src/http/crawl/scrape-context';

function getCookieHeader(headers: any): string | undefined {
  if (headers && typeof headers.get === 'function') {
    return headers.get('Cookie') as string | undefined;
  }
  return headers?.Cookie as string | undefined;
}

describe('HttpClient cookie jar', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    // Spec 1690: fresh crawl-policy state, so pacing from one test never delays the next.
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
  });

  it('stores Set-Cookie from a response and replays it on the next request', async () => {
    const client = new HttpClient({ cookies: true });
    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['session=abc; Path=/; HttpOnly'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api');

    expect(mockAxiosRequest).toHaveBeenCalledTimes(2);
    expect(getCookieHeader(mockAxiosRequest.mock.calls[1][0].headers)).toBe('session=abc');
  });

  it('merges jar cookies with a manually supplied Cookie header', async () => {
    const client = new HttpClient({ cookies: true });
    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['jar=value; Path=/'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api', { headers: { Cookie: 'manual=1' } });

    const cookieHeader = getCookieHeader(mockAxiosRequest.mock.calls[1][0].headers);
    expect(cookieHeader).toContain('manual=1');
    expect(cookieHeader).toContain('jar=value');
    expect(cookieHeader).toMatch(/^manual=1; jar=value$/);
  });

  it('does not send cookies when the cookie jar is not enabled', async () => {
    const client = new HttpClient();
    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['session=abc; Path=/'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api');

    expect(getCookieHeader(mockAxiosRequest.mock.calls[1][0].headers)).toBeUndefined();
  });

  it('shares state through a supplied CookieJar instance across clients', async () => {
    const sharedJar = new CookieJar();
    const clientA = new HttpClient({ cookies: sharedJar });
    const clientB = new HttpClient({ cookies: sharedJar });

    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'from-a', headers: { 'set-cookie': ['token=shared; Path=/'] } })
      .mockResolvedValueOnce({ data: 'from-b' });

    await clientA.get('https://example.com/api');
    await clientB.get('https://example.com/api');

    expect(getCookieHeader(mockAxiosRequest.mock.calls[1][0].headers)).toBe('token=shared');
  });

  it('ignores malformed Set-Cookie headers instead of failing the request', async () => {
    const client = new HttpClient({ cookies: true });
    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['this is not a valid cookie'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api');

    expect(getCookieHeader(mockAxiosRequest.mock.calls[1][0].headers)).toBeUndefined();
  });

  it('merges with an AxiosHeaders Cookie header', async () => {
    const { AxiosHeaders } = jest.requireActual('axios');
    const client = new HttpClient({ cookies: true });

    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['fromjar=1; Path=/'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api', {
      headers: new AxiosHeaders({ Cookie: 'manual=2' }),
    });

    const sentHeaders = mockAxiosRequest.mock.calls[1][0].headers;
    expect(getCookieHeader(sentHeaders)).toBe('manual=2; fromjar=1');
  });

  it('stores Set-Cookie from a non-retryable error response', async () => {
    const jar = new CookieJar();
    const client = new HttpClient({ cookies: jar });

    mockAxiosRequest.mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), {
        response: {
          status: 403,
          headers: { 'set-cookie': ['csrf=token; Path=/; HttpOnly'] },
        },
      }),
    );

    await expect(client.get('https://example.com/api')).rejects.toThrow('Forbidden');
    expect(jar.getCookieStringSync('https://example.com/api')).toBe('csrf=token');
  });

  it('coexists with the crawl-policy identity interceptor (Spec 1690)', async () => {
    const client = new HttpClient({ cookies: true });
    client.setHeaders({ 'User-Agent': 'Declared/1.0' });
    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['session=abc; Path=/'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api');

    const sent = mockAxiosRequest.mock.calls[1][0].headers;
    expect(getCookieHeader(sent)).toBe('session=abc');
    expect(sent['User-Agent']).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  it('forwards the cookies option through createHttpClient even when proxies are set', async () => {
    const client = createHttpClient({ proxies: ['localhost'], timeout: 5, cookies: true });
    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['session=p; Path=/'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api');

    expect(getCookieHeader(mockAxiosRequest.mock.calls[1][0].headers)).toBe('session=p');
  });

  it('forwards the cookies option through createHttpClient', async () => {
    const client = createHttpClient({ requestTimeout: 30, cookies: true });
    mockAxiosRequest
      .mockResolvedValueOnce({ data: 'first', headers: { 'set-cookie': ['session=xyz; Path=/'] } })
      .mockResolvedValueOnce({ data: 'second' });

    await client.get('https://example.com/api');
    await client.get('https://example.com/api');

    expect(getCookieHeader(mockAxiosRequest.mock.calls[1][0].headers)).toBe('session=xyz');
  });
});
