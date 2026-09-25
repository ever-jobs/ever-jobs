import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { getRequestId } from '../context';
import { memoisedRequest } from './http-memo';
import { describeUrlForLog, pinUrlToHosts } from '../utils/url-guard';

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

/**
 * Query-string keys whose values must never reach a log line. Several sources
 * authenticate by query parameter (`source-ats-ceipal` `api_key`,
 * `source-ats-jazzhr` `apikey`, `source-ats-teamtailor` / `source-ats-talentera`
 * / `source-ats-comeet` `token`), so naming the raw URL on retry would copy
 * those credentials into the pod logs.
 */
const SENSITIVE_QUERY_KEYS =
  /^(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd|auth|authorization|signature|sig|session|credentials?)$/i;

/**
 * Hosts that carry a credential in the URL *path* rather than the query string,
 * mapped to the zero-based index of the offending path segment. Ceipal routes
 * every tenant call through `https://api.ceipal.com/{apiKey}/job-postings/`, so
 * the first segment is the tenant's career-portal key — `CeipalService` already
 * masks it in its own logs (`maskKey`), and the shared retry line must not undo
 * that. `source-ats-ceipal` is currently the only plugin that builds a URL this
 * way; add a row here if another one appears.
 */
const SENSITIVE_PATH_SEGMENTS: Record<string, number> = {
  'api.ceipal.com': 0,
};

/** Scheme + authority of an absolute URL, e.g. `https://api.ceipal.com:443`. */
const URL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/**
 * `false` turns {@link HttpClientOptions.allowedRedirectHosts} off process-wide
 * (redirects are followed as axios does by default) — an escape hatch should a
 * pinned site start redirecting somewhere legitimate. Default on.
 */
export const HTTP_PIN_REDIRECTS_ENV = 'EVER_JOBS_HTTP_PIN_REDIRECTS';

function redirectPinningEnabled(): boolean {
  const raw = process.env[HTTP_PIN_REDIRECTS_ENV]?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

/**
 * The `beforeRedirect` hook for a pinned client: every hop must itself be an
 * https URL on `allowedHosts` (or a subdomain), checked by the same
 * {@link pinUrlToHosts} the plugin ran on the first URL. Throwing aborts the
 * redirect, so the request rejects instead of following it.
 */
export function redirectPinGuard(
  allowedHosts: readonly string[],
): (redirectOptions: Record<string, unknown>) => void {
  return (redirectOptions) => {
    const href = typeof redirectOptions.href === 'string' ? redirectOptions.href : '';
    if (!pinUrlToHosts(href, allowedHosts)) {
      throw new Error(
        `Refused redirect to ${describeUrlForLog(href)}: not an https URL on ${allowedHosts.join(', ')}`,
      );
    }
  };
}

export interface HttpClientOptions {
  proxies?: string[];
  caCert?: string;
  userAgent?: string;
  retries?: number;
  /** Base backoff between retries, in MILLISECONDS (default 1000). */
  retryDelay?: number;
  retryBackoff?: 'linear' | 'exponential';
  /** Ceiling on any single retry wait, in MILLISECONDS (default 30000). */
  retryMaxDelay?: number;
  /**
   * Per-request timeout in SECONDS (default 60) -- NOT milliseconds. It is
   * multiplied by 1000 below, so `timeout: 10000` asks for ~2.8 hours rather
   * than 10 seconds. The retry delays above are milliseconds; this one is not.
   */
  timeout?: number;
  /** Minimum delay between requests in seconds (rate limiting) */
  rateDelayMin?: number;
  /** Maximum delay between requests in seconds (rate limiting) */
  rateDelayMax?: number;
  /**
   * Enable cookie handling. When `true`, an isolated `CookieJar` is created for
   * this client. Pass a `CookieJar` instance to share state across requests.
   */
  cookies?: boolean | CookieJar;
  /**
   * Pin every redirect hop to these hosts (Spec 1689). Unset (the default),
   * axios follows up to 21 redirects to any host and scheme, so a pinned
   * first URL on an allowlisted host with an open redirect could still land
   * on loopback, a private range or cloud metadata. Set, each hop must pass
   * `pinUrlToHosts(hop, allowedRedirectHosts)` — https only, same hosts or
   * their subdomains, no credentials or explicit port — or the request
   * rejects. `EVER_JOBS_HTTP_PIN_REDIRECTS=false` turns it off process-wide.
   */
  allowedRedirectHosts?: readonly string[];
}

/**
 * HTTP client with rotating proxy support and rate limiting.
 * Replaces Python's RotatingProxySession / RequestsRotating / TLSRotating.
 */
@Injectable()
export class HttpClient {
  private readonly logger = new Logger(HttpClient.name);
  private readonly client: AxiosInstance;
  private readonly proxies: string[];
  private proxyIndex = 0;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly retryBackoff: 'linear' | 'exponential';
  private readonly retryMaxDelay: number;
  private readonly rateDelayMin: number;
  private readonly rateDelayMax: number;
  private lastRequestTime = 0;
  private readonly cookieJar?: CookieJar;

  constructor(options: HttpClientOptions = {}) {
    this.proxies = options.proxies ?? [];
    this.maxRetries = options.retries ?? 3;
    this.retryDelay = options.retryDelay ?? 1000;
    this.retryBackoff = options.retryBackoff ?? 'linear';
    this.retryMaxDelay = options.retryMaxDelay ?? 30000;
    this.rateDelayMin = (options.rateDelayMin ?? 0) * 1000; // convert to ms
    this.rateDelayMax = (options.rateDelayMax ?? 0) * 1000;

    this.client = axios.create({
      timeout: (options.timeout ?? 60) * 1000,
      headers: {
        'User-Agent':
          options.userAgent ??
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      // Accept self-signed certs if caCert is configured
      ...(options.caCert
        ? { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) }
        : {}),
      ...(options.allowedRedirectHosts?.length && redirectPinningEnabled()
        ? { beforeRedirect: redirectPinGuard(options.allowedRedirectHosts) }
        : {}),
    });

    if (options.cookies) {
      this.cookieJar = options.cookies === true ? new CookieJar() : options.cookies;
      this.attachCookieInterceptors();
    }
  }

  private attachCookieInterceptors(): void {
    if (!this.cookieJar) return;

    this.client.interceptors.request.use(async (config) => {
      this.applyRequestCookies(config);
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        this.storeResponseCookies(response);
        return response;
      },
      (error) => {
        if (error.response) {
          this.storeResponseCookies(error.response);
        }
        return Promise.reject(error);
      },
    );
  }

  private applyRequestCookies(config: AxiosRequestConfig): void {
    if (!this.cookieJar || !config.url) return;

    const cookieString = this.cookieJar.getCookieStringSync(config.url);
    if (!cookieString) return;

    const headers = config.headers ?? (config.headers = {});
    if (
      typeof (headers as { get?: unknown }).get === 'function' &&
      typeof (headers as { set?: unknown }).set === 'function'
    ) {
      const axiosHeaders = headers as { get: (key: string) => string | undefined; set: (key: string, value: string) => void };
      const existing = axiosHeaders.get('Cookie') ?? '';
      axiosHeaders.set('Cookie', existing ? `${existing}; ${cookieString}` : cookieString);
    } else {
      const existing = (headers as Record<string, unknown>)['Cookie'] ?? '';
      (headers as Record<string, string>)['Cookie'] = existing
        ? `${existing}; ${cookieString}`
        : cookieString;
    }
  }

  private storeResponseCookies(response: AxiosResponse): void {
    if (!this.cookieJar) return;

    const setCookie = response.headers?.['set-cookie'];
    if (!setCookie) return;

    const url = response.config?.url;
    if (!url) return;

    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of cookies) {
      try {
        this.cookieJar.setCookieSync(cookie, url);
      } catch (err) {
        this.logger.debug(`Ignoring malformed Set-Cookie: ${err}`);
      }
    }
  }

  private getNextProxy(): string | null {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.proxyIndex % this.proxies.length];
    this.proxyIndex++;
    return proxy;
  }

  private createAgent(proxy: string): HttpsProxyAgent<string> | SocksProxyAgent {
    if (proxy.startsWith('socks5://') || proxy.startsWith('socks4://')) {
      return new SocksProxyAgent(proxy);
    }
    const proxyUrl = proxy.startsWith('http') ? proxy : `http://${proxy}`;
    return new HttpsProxyAgent(proxyUrl);
  }

  /**
   * Enforce rate limiting delay before making a request.
   * Uses monotonic timestamps to avoid being affected by system time changes.
   */
  private async enforceRateDelay(): Promise<void> {
    if (this.rateDelayMin <= 0) return;

    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const delay = this.rateDelayMax > this.rateDelayMin
      ? this.rateDelayMin + Math.random() * (this.rateDelayMax - this.rateDelayMin)
      : this.rateDelayMin;

    if (this.lastRequestTime > 0 && elapsed < delay) {
      const wait = delay - elapsed;
      this.logger.debug(`Rate limiting: waiting ${(wait / 1000).toFixed(1)}s`);
      await this.sleep(wait);
    }

    this.lastRequestTime = Date.now();
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }

  async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // Spec 1700 (T13) — inside a multi-location scope, a request identical to
    // one already answered is served from the scope's memo (see http-memo.ts).
    // A memo hit skips the response interceptors, so its Set-Cookie headers are
    // replayed into this client's jar here (a no-op without a jar).
    return memoisedRequest<T>(
      config,
      this.client.defaults.headers,
      () => this.send<T>(config),
      (response) => this.storeResponseCookies(response),
    );
  }

  private async send<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // Enforce rate limiting before making the request
    await this.enforceRateDelay();

    const proxy = this.getNextProxy();
    if (proxy && proxy !== 'localhost') {
      const agent = this.createAgent(proxy);
      config.httpAgent = agent;
      config.httpsAgent = agent;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.client.request<T>(config);
      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        if (status && RETRYABLE_STATUSES.includes(status) && attempt < this.maxRetries) {
          const backoff = this.retryBackoff === 'exponential'
            ? this.retryDelay * Math.pow(2, attempt)
            : this.retryDelay * (attempt + 1);
          // A server that sent Retry-After has stated its own terms; retrying sooner
          // (429 especially) only extends the block. Take whichever wait is longer:
          // a malformed, negative or already-past Retry-After parses to 0 ms, and
          // honouring that verbatim would discard the backoff and hammer the host.
          const delay = Math.min(
            this.retryMaxDelay,
            Math.max(backoff, this.retryAfterMs(error.response?.headers) ?? 0),
          );

          this.logger.warn(`${this.describeRequest(config)} failed ${status}, retry ${attempt + 1}/${this.maxRetries} in ${delay}ms`);
          await this.sleep(delay);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  /** Update default headers for this client instance */
  setHeaders(headers: Record<string, string>): void {
    Object.assign(this.client.defaults.headers.common, headers);
  }

  /** Get the underlying Axios instance for low-level access */
  getAxiosInstance(): AxiosInstance {
    return this.client;
  }

  /**
   * Identify the request a log line is about. Scrapers fan out concurrently, so a
   * message without its own target cannot be attributed to anything.
   */
  private describeRequest(config: AxiosRequestConfig): string {
    const method = (config.method ?? 'GET').toUpperCase();
    const url = config.url ? this.redactUrl(config.url) : '(no url)';
    const requestId = getRequestId();
    return requestId ? `[${requestId}] ${method} ${url}` : `${method} ${url}`;
  }

  /**
   * Strip credentials out of a URL before it reaches a log line, leaving the
   * rest intact so the message still names its target. Splits on delimiters
   * rather than parsing, so a relative or malformed URL degrades to "unchanged"
   * instead of throwing inside a logging path.
   */
  private redactUrl(url: string): string {
    return this.redactQuery(this.redactPathCredential(url));
  }

  /**
   * Replace a credential carried as a path segment (see
   * `SENSITIVE_PATH_SEGMENTS`) with `REDACTED`. Relative URLs and hosts with no
   * rule are returned unchanged.
   */
  private redactPathCredential(url: string): string {
    const authority = URL_AUTHORITY.exec(url);
    if (!authority) return url;

    const host = authority[1].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase();
    const index = SENSITIVE_PATH_SEGMENTS[host];
    if (index === undefined) return url;

    const pathStart = authority[0].length;
    const query = url.indexOf('?', pathStart);
    const fragment = url.indexOf('#', pathStart);
    const ends = [query, fragment].filter((i) => i !== -1);
    const pathEnd = ends.length ? Math.min(...ends) : url.length;

    // A path that starts with `/` splits to a leading empty segment, so the
    // first real segment is at index 1.
    const segments = url.slice(pathStart, pathEnd).split('/');
    const target = index + 1;
    if (target >= segments.length || !segments[target]) return url;

    segments[target] = 'REDACTED';
    return url.slice(0, pathStart) + segments.join('/') + url.slice(pathEnd);
  }

  /**
   * Replace the value of every credential-bearing query parameter with
   * `REDACTED`.
   */
  private redactQuery(url: string): string {
    const start = url.indexOf('?');
    if (start === -1) return url;

    const [query, ...fragment] = url.slice(start + 1).split('#');
    const redacted = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const key = pair.slice(0, eq);
        return SENSITIVE_QUERY_KEYS.test(key) ? `${key}=REDACTED` : pair;
      })
      .join('&');

    const hash = fragment.length ? `#${fragment.join('#')}` : '';
    return `${url.slice(0, start)}?${redacted}${hash}`;
  }

  /** `Retry-After` as milliseconds: delta-seconds or an HTTP-date. Null when absent/unparseable. */
  private retryAfterMs(headers: unknown): number | null {
    const raw = (headers as Record<string, unknown> | undefined)?.['retry-after'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' && typeof value !== 'number') return null;

    const text = String(value).trim();
    if (!text) return null;

    if (/^\d+$/.test(text)) return Number(text) * 1000;

    const date = Date.parse(text);
    if (Number.isNaN(date)) return null;
    return Math.max(0, date - Date.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Factory to create HttpClient instances with options.
 */
/**
 * Factory to create HttpClient instances with options.
 * Can accept either HttpClientOptions or ScraperInputDto.
 */
export function createHttpClient(options?: HttpClientOptions | any): HttpClient {
  if (options && (options.requestTimeout !== undefined || options.proxies !== undefined)) {
    // It's likely a ScraperInputDto or a similar object from a scraper
    return new HttpClient({
      proxies: options.proxies,
      caCert: options.caCert,
      userAgent: options.userAgent,
      timeout: options.requestTimeout,
      retries: options.retries,
      retryDelay: options.retryDelay,
      retryBackoff: options.retryBackoff,
      retryMaxDelay: options.retryMaxDelay,
      rateDelayMin: options.rateDelayMin,
      rateDelayMax: options.rateDelayMax,
      cookies: options.cookies,
      allowedRedirectHosts: options.allowedRedirectHosts,
    });
  }
  return new HttpClient(options as HttpClientOptions);
}

