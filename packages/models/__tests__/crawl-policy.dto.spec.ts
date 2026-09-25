import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CRAWL_POLICY_DTO_VALUES, CrawlPolicyDto, ScraperInputDto } from '../src';

/**
 * Spec 1690 §5.2 — `ScraperInputDto.crawl` / `CrawlPolicyDto` validation.
 * Every field is optional; enums, non-negative integers, status arrays and
 * header-safe strings are enforced; unknown nested keys are stripped by the
 * API's global `ValidationPipe({ transform: true, whitelist: true })`.
 */
describe('CrawlPolicyDto (Spec 1690)', () => {
  const errorsFor = async (plain: Record<string, unknown>): Promise<string[]> => {
    const errors = await validate(plainToInstance(CrawlPolicyDto, plain));
    return errors.map((e) => e.property);
  };

  it('accepts an empty object (every field optional)', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  it('accepts a fully populated, valid policy', async () => {
    const full = {
      userAgent: 'Mozilla/5.0 (compatible; AcmeBot/2.0; +https://acme.example/bot)',
      userAgentMode: 'strict',
      from: 'ops@acme.example',
      stripClientHints: true,
      proxyRotation: 'per-host',
      rateLimitScope: 'domain',
      maxConcurrentPerHost: 1,
      minIntervalMs: 1000,
      jitterMs: 250,
      maxQueueWaitMs: 0,
      adaptiveThrottle: true,
      retries: 0,
      retryStatuses: [429, 503],
      retryBackoff: 'exponential',
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
      retryJitter: true,
      retryOnNetworkError: false,
      respectRetryAfter: true,
      maxRetryAfterMs: 60000,
      retryAfterOverMax: 'give-up',
      robotsTxt: 'respect',
      blockPrivateNetworks: true,
      discovery: 'sitemap',
    };
    expect(await errorsFor(full)).toEqual([]);
  });

  it.each(Object.entries(CRAWL_POLICY_DTO_VALUES))('accepts every allowed %s value', async (field, values) => {
    for (const value of values) {
      expect(await errorsFor({ [field]: value })).toEqual([]);
    }
  });

  it.each(Object.keys(CRAWL_POLICY_DTO_VALUES))('rejects an unknown %s value', async (field) => {
    expect(await errorsFor({ [field]: 'sideways' })).toEqual([field]);
  });

  it.each([
    'maxConcurrentPerHost',
    'minIntervalMs',
    'jitterMs',
    'maxQueueWaitMs',
    'retries',
    'retryBaseDelayMs',
    'retryMaxDelayMs',
    'maxRetryAfterMs',
  ])('%s: accepts 0 and positive integers, rejects negatives, fractions and strings', async (field) => {
    expect(await errorsFor({ [field]: 0 })).toEqual([]);
    expect(await errorsFor({ [field]: 5 })).toEqual([]);
    expect(await errorsFor({ [field]: -1 })).toEqual([field]);
    expect(await errorsFor({ [field]: 1.5 })).toEqual([field]);
    expect(await errorsFor({ [field]: '5' })).toEqual([field]);
  });

  it.each([
    'stripClientHints',
    'adaptiveThrottle',
    'retryJitter',
    'retryOnNetworkError',
    'respectRetryAfter',
    'blockPrivateNetworks',
  ])('%s: accepts booleans only', async (field) => {
    expect(await errorsFor({ [field]: false })).toEqual([]);
    expect(await errorsFor({ [field]: 'yes' })).toEqual([field]);
  });

  it('retryStatuses: requires an array of HTTP status integers', async () => {
    expect(await errorsFor({ retryStatuses: [] })).toEqual([]);
    expect(await errorsFor({ retryStatuses: 429 })).toEqual(['retryStatuses']);
    expect(await errorsFor({ retryStatuses: [429, 'x'] })).toEqual(['retryStatuses']);
    expect(await errorsFor({ retryStatuses: [42] })).toEqual(['retryStatuses']);
    expect(await errorsFor({ retryStatuses: [600] })).toEqual(['retryStatuses']);
  });

  it('userAgent / from: must be single header lines', async () => {
    expect(await errorsFor({ userAgent: 'Bot/1.0\r\nX-Evil: 1' })).toEqual(['userAgent']);
    expect(await errorsFor({ from: 'ops@acme.example\nX: y' })).toEqual(['from']);
    expect(await errorsFor({ userAgent: 'x'.repeat(1025) })).toEqual(['userAgent']);
    expect(await errorsFor({ userAgent: 42 })).toEqual(['userAgent']);
  });
});

describe('ScraperInputDto.crawl (Spec 1690)', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
  const body = { type: 'body' as const, metatype: ScraperInputDto };

  it('keeps every pre-1690 field and adds an optional crawl', async () => {
    const input = (await pipe.transform(
      {
        searchTerm: 'engineer',
        userAgent: 'Legacy/1.0',
        rateDelayMin: 1,
        rateDelayMax: 2,
        retries: 1,
        retryDelay: 500,
        retryBackoff: 'exponential',
        retryMaxDelay: 5000,
      },
      body,
    )) as ScraperInputDto;
    expect(input).toBeInstanceOf(ScraperInputDto);
    expect(input.crawl).toBeUndefined();
    expect(input).toMatchObject({
      userAgent: 'Legacy/1.0',
      rateDelayMin: 1,
      rateDelayMax: 2,
      retries: 1,
      retryDelay: 500,
      retryBackoff: 'exponential',
      retryMaxDelay: 5000,
    });
  });

  it('transforms crawl into a CrawlPolicyDto and strips unknown nested keys', async () => {
    const input = (await pipe.transform(
      { searchTerm: 'engineer', crawl: { maxConcurrentPerHost: 1, discovery: 'sitemap', bogus: true } },
      body,
    )) as ScraperInputDto;
    expect(input.crawl).toBeInstanceOf(CrawlPolicyDto);
    expect({ ...input.crawl }).toEqual({ maxConcurrentPerHost: 1, discovery: 'sitemap' });
  });

  it('rejects the request (400) when a nested crawl field is invalid', async () => {
    await expect(
      pipe.transform({ searchTerm: 'engineer', crawl: { proxyRotation: 'sideways' } }, body),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pipe.transform({ searchTerm: 'engineer', crawl: { minIntervalMs: -5 } }, body),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a crawl that is not an object', async () => {
    await expect(pipe.transform({ searchTerm: 'x', crawl: 'polite' }, body)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('the constructor does not default crawl (so an absent crawl never becomes a caller override)', () => {
    expect(new ScraperInputDto().crawl).toBeUndefined();
    expect(new ScraperInputDto({ crawl: { retries: 0 } as CrawlPolicyDto }).crawl).toEqual({ retries: 0 });
  });
});

describe('ScraperInputDto.proxies (Spec 1690 §4.4)', () => {
  const errorsFor = async (plain: Record<string, unknown>): Promise<string[]> => {
    const errors = await validate(plainToInstance(ScraperInputDto, plain));
    return errors.map((e) => e.property);
  };

  it('accepts a list of proxy URL strings', async () => {
    expect(await errorsFor({ proxies: ['http://p1.example:8080', 'socks5://p2.example:1080'] })).toEqual([]);
  });

  it('rejects non-string entries (they used to crash HttpClient: proxy.startsWith is not a function)', async () => {
    expect(await errorsFor({ proxies: ['http://p1.example:8080', 42] })).toEqual(['proxies']);
    expect(await errorsFor({ proxies: [{ host: 'x' }] })).toEqual(['proxies']);
  });
});
