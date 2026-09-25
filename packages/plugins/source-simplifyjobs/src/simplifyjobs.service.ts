import { SourcePlugin } from '@ever-jobs/plugin';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScrapeDiagnostics,
  ScraperInputDto,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import {
  SIMPLIFYJOBS_BRANCH_RE,
  SIMPLIFYJOBS_DEFAULT_RETRIES,
  SIMPLIFYJOBS_DEFAULT_TTL_MS,
  SIMPLIFYJOBS_DEFAULTS,
  SIMPLIFYJOBS_ENV,
  SIMPLIFYJOBS_ERROR_BACKOFF_MS,
  SIMPLIFYJOBS_FEED_PATH,
  SIMPLIFYJOBS_LOCATION_MEMO_MAX,
  SIMPLIFYJOBS_MAX_BODY_BYTES,
  SIMPLIFYJOBS_MAX_TTL_MS,
  SIMPLIFYJOBS_MIN_INTERVAL_S,
  SIMPLIFYJOBS_MIN_TTL_MS,
  SIMPLIFYJOBS_RAW_BASE,
  SIMPLIFYJOBS_RAW_HOST,
  SIMPLIFYJOBS_REPO_RE,
  SIMPLIFYJOBS_ROBOTS_MAX_BYTES,
  SIMPLIFYJOBS_ROBOTS_TOKEN,
  SIMPLIFYJOBS_ROBOTS_TTL_MS,
  SIMPLIFYJOBS_ROBOTS_URL,
  SIMPLIFYJOBS_SITE,
  SIMPLIFYJOBS_STALE_FEED_WARN_MS,
  SIMPLIFYJOBS_STALE_MAX_MS,
  SIMPLIFYJOBS_TIMEOUT_SECONDS,
  SIMPLIFYJOBS_UNSUPPORTED_JOB_TYPE_DETAIL,
  SIMPLIFYJOBS_USER_AGENT,
} from './simplifyjobs.constants';
import { FeedCache, FeedFetchResult, headerValue, parseMaxAgeMs } from './simplifyjobs.feed-cache';
import { parseFeedBody, SimplifyFeedFormatError } from './simplifyjobs.feed-parser';
import { mapRowToJobPost } from './simplifyjobs.mapper';
import {
  buildLocationQuery,
  LocationFactsMemo,
  resolvePaging,
  routeJobType,
  selectPage,
  SimplifyFilter,
  tokenizeSearchTerm,
} from './simplifyjobs.query';
import {
  parseRobotsTxt,
  RobotsDisallowedError,
  robotsAllows,
  RobotsRule,
  RobotsUnreachableError,
} from './simplifyjobs.robots';
import { SimplifyFeedKind, SimplifyFeedOutcome, SimplifyRow } from './simplifyjobs.types';

/** Optional clock (epoch ms) for the caches and freshness filters; tests inject one. */
export const SIMPLIFYJOBS_CLOCK = Symbol('SIMPLIFYJOBS_CLOCK');

type HttpClient = ReturnType<typeof createHttpClient>;

/** Feed URLs for one scrape, after env overrides. */
export type SimplifyFeedUrls = Record<SimplifyFeedKind, string>;

const MAX_DETAIL = 500;

/**
 * Simplify's two curated early-career lists (full-time new-grad roles and
 * internships), published as `listings.json` files (Spec 1694).
 *
 * Each needed list is one conditional GET per cache window, fetched
 * sequentially, parsed row by row and compacted to the fields we map; the
 * compacted rows are cached on this (singleton) service with their ETag and
 * shared by concurrent scrapes. All searching, filtering and paging is local.
 * robots.txt of the host is checked before any feed request.
 */
@SourcePlugin({
  site: SIMPLIFYJOBS_SITE,
  name: 'Simplify (new grad & internships)',
  category: 'niche',
  description:
    "Simplify's public, community-curated lists of new-grad roles and internships, read from the listings " +
    'files it publishes on GitHub. Only factual fields are used (title, company, locations, dates, category, ' +
    'terms and the employer apply URL); the lists carry no job descriptions.',
})
@Injectable()
export class SimplifyJobsService implements IScraper {
  private readonly logger = new Logger(SimplifyJobsService.name);
  private readonly now: () => number;
  private readonly feeds: FeedCache<SimplifyRow[]>;
  private readonly robots: FeedCache<RobotsRule[]>;
  private readonly locationMemo = new LocationFactsMemo(SIMPLIFYJOBS_LOCATION_MEMO_MAX);
  /** Invalid overrides already warned about, so a bad value logs once, not per search. */
  private readonly warnedEnv = new Set<string>();

  constructor(@Optional() @Inject(SIMPLIFYJOBS_CLOCK) clock?: () => number) {
    this.now = typeof clock === 'function' ? clock : () => Date.now();
    this.feeds = new FeedCache<SimplifyRow[]>(this.now, {
      defaultTtlMs: SIMPLIFYJOBS_DEFAULT_TTL_MS,
      minTtlMs: SIMPLIFYJOBS_MIN_TTL_MS,
      maxTtlMs: SIMPLIFYJOBS_MAX_TTL_MS,
      staleMaxMs: SIMPLIFYJOBS_STALE_MAX_MS,
      errorBackoffMs: SIMPLIFYJOBS_ERROR_BACKOFF_MS,
      maxEntries: 4,
    });
    this.robots = new FeedCache<RobotsRule[]>(this.now, {
      defaultTtlMs: SIMPLIFYJOBS_ROBOTS_TTL_MS,
      minTtlMs: SIMPLIFYJOBS_ROBOTS_TTL_MS,
      maxTtlMs: SIMPLIFYJOBS_ROBOTS_TTL_MS,
      // RFC 9309 §2.4: while robots.txt is unreachable an older copy may be used.
      staleMaxMs: 7 * SIMPLIFYJOBS_ROBOTS_TTL_MS,
      errorBackoffMs: SIMPLIFYJOBS_ERROR_BACKOFF_MS,
      maxEntries: 1,
    });
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const route = routeJobType(input.jobType);
    if (route === null) {
      this.logger.log(`Simplify: job type "${String(input.jobType)}" is on neither list; no request made`);
      return new JobResponseDto([], new ScrapeDiagnostics('empty', SIMPLIFYJOBS_UNSUPPORTED_JOB_TYPE_DETAIL));
    }

    try {
      const urls = this.resolveFeedUrls();
      const http = this.createClient(input);
      const lists: SimplifyRow[][] = [];
      const outcomes: SimplifyFeedOutcome[] = [];

      // One feed at a time: at most one body is in memory while it is parsed.
      for (const feed of route.feeds) {
        const url = urls[feed];
        try {
          const read = await this.feeds.get(url, (etag) => this.fetchFeed(http, feed, url, etag));
          lists.push(read.value);
          outcomes.push({ feed, source: read.source, rows: read.value.length, ageMs: read.ageMs, error: read.error });
        } catch (err: unknown) {
          this.logger.warn(`Simplify ${feed} feed failed: ${errorMessage(err)}`);
          outcomes.push({ feed, source: 'failed', rows: 0, error: err });
        }
      }

      const failed = outcomes.filter((o) => o.source === 'failed');
      if (failed.length === outcomes.length) {
        return new JobResponseDto([], allFailedDiagnostics(failed));
      }

      const nowMs = this.now();
      const filter = buildFilter(input, route.summerOnly, nowMs);
      const { offset, limit } = resolvePaging(input.offset, input.resultsWanted);
      const page = selectPage(lists, filter, this.locationMemo, offset, limit);

      const jobs: JobPostDto[] = [];
      for (const row of page.rows) {
        try {
          jobs.push(mapRowToJobPost(row, nowMs, SIMPLIFYJOBS_SITE));
        } catch (err: unknown) {
          this.logger.warn(`Simplify: skipping row ${row.id}: ${errorMessage(err)}`);
        }
      }

      this.logger.log(
        `Simplify: feeds=${outcomes.map((o) => `${o.feed}:${o.source}`).join(',')} ` +
          `live=${lists.reduce((n, l) => n + l.length, 0)} matched=${page.matched}${page.exhausted ? '' : '+'} returned=${jobs.length}`,
      );
      return new JobResponseDto(jobs, partialDiagnostics(outcomes));
    } catch (err: unknown) {
      this.logger.error(`Simplify scrape error: ${errorMessage(err)}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Feed URLs with operator overrides applied. Read on every scrape; an
   * invalid override is ignored with a warning.
   */
  resolveFeedUrls(env: NodeJS.ProcessEnv = process.env): SimplifyFeedUrls {
    const newGradRepo = this.envValue(env, SIMPLIFYJOBS_ENV.newGradRepo, SIMPLIFYJOBS_DEFAULTS.newGradRepo, isValidRepo);
    const internshipsRepo = this.envValue(
      env,
      SIMPLIFYJOBS_ENV.internshipsRepo,
      SIMPLIFYJOBS_DEFAULTS.internshipsRepo,
      isValidRepo,
    );
    const branch = this.envValue(env, SIMPLIFYJOBS_ENV.branch, SIMPLIFYJOBS_DEFAULTS.branch, isValidBranch);
    return {
      newgrad: feedUrl(newGradRepo, branch),
      internships: feedUrl(internshipsRepo, branch),
    };
  }

  private envValue(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: string,
    valid: (value: string) => boolean,
  ): string {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = raw.trim();
    if (!value) return fallback;
    if (valid(value)) return value;
    const key = `${name}=${value}`;
    if (!this.warnedEnv.has(key) && this.warnedEnv.size < 100) {
      this.warnedEnv.add(key);
      this.logger.warn(`Simplify: ignoring invalid ${name}="${value.slice(0, 120)}"; using "${fallback}"`);
    }
    return fallback;
  }

  private createClient(input: ScraperInputDto): HttpClient {
    const timeout =
      typeof input.requestTimeout === 'number' && input.requestTimeout > 0 ? input.requestTimeout : SIMPLIFYJOBS_TIMEOUT_SECONDS;
    const userAgent = typeof input.userAgent === 'string' && input.userAgent.trim() ? input.userAgent.trim() : SIMPLIFYJOBS_USER_AGENT;
    const minDelay = Math.max(SIMPLIFYJOBS_MIN_INTERVAL_S, finiteOr(input.rateDelayMin, SIMPLIFYJOBS_MIN_INTERVAL_S));
    return createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      userAgent,
      // Both spellings: the input-shaped branch of createHttpClient reads
      // `requestTimeout`, the options branch reads `timeout` (SECONDS).
      timeout,
      requestTimeout: timeout,
      retries: typeof input.retries === 'number' && input.retries >= 0 ? input.retries : SIMPLIFYJOBS_DEFAULT_RETRIES,
      retryDelay: input.retryDelay,
      retryBackoff: input.retryBackoff,
      retryMaxDelay: input.retryMaxDelay,
      rateDelayMin: minDelay,
      rateDelayMax: Math.max(minDelay, finiteOr(input.rateDelayMax, minDelay)),
      allowedRedirectHosts: [SIMPLIFYJOBS_RAW_HOST],
    });
  }

  /** One conditional GET of a feed, after the robots.txt check; parsed and compacted before returning. */
  private async fetchFeed(
    http: HttpClient,
    feed: SimplifyFeedKind,
    url: string,
    etag: string | null,
  ): Promise<FeedFetchResult<SimplifyRow[]>> {
    await this.assertRobotsAllow(http, url);

    const response = await http.get<unknown>(url, {
      // Bytes, not text: the body is scanned row by row, never held as one string.
      responseType: 'arraybuffer',
      maxContentLength: SIMPLIFYJOBS_MAX_BODY_BYTES,
      headers: {
        Accept: 'application/json, text/plain;q=0.9',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      validateStatus: (status: number) => (status >= 200 && status < 300) || status === 304,
    });

    const maxAgeMs = parseMaxAgeMs(headerValue(response.headers, 'cache-control'));
    if (response.status === 304) {
      return { status: 'not-modified', etag: headerValue(response.headers, 'etag'), maxAgeMs };
    }

    const parsed = parseFeedBody(response.data, feed);
    this.logger.log(`Simplify ${feed}: ${parsed.total} rows in feed, ${parsed.rows.length} live`);
    if (parsed.skipped > 0) this.logger.debug(`Simplify ${feed}: ${parsed.skipped} non-object elements skipped`);
    this.warnIfStale(feed, parsed.newestPosted);
    return { status: 'fresh', value: parsed.rows, etag: headerValue(response.headers, 'etag'), maxAgeMs };
  }

  /** The feed repositories are renamed yearly; a list that stops moving has probably moved. */
  private warnIfStale(feed: SimplifyFeedKind, newestPosted: number | null): void {
    if (newestPosted === null) return;
    const ageMs = this.now() - newestPosted * 1000;
    if (ageMs <= SIMPLIFYJOBS_STALE_FEED_WARN_MS) return;
    const envName = feed === 'internships' ? SIMPLIFYJOBS_ENV.internshipsRepo : SIMPLIFYJOBS_ENV.newGradRepo;
    this.logger.warn(
      `Simplify ${feed}: newest posting is ${Math.floor(ageMs / 86_400_000)} days old; ` +
        `the list may have been renamed or frozen (check ${envName})`,
    );
  }

  private async assertRobotsAllow(http: HttpClient, url: string): Promise<void> {
    let rules: RobotsRule[];
    try {
      rules = (await this.robots.get(SIMPLIFYJOBS_ROBOTS_URL, () => this.fetchRobots(http))).value;
    } catch (err: unknown) {
      throw new RobotsUnreachableError(errorMessage(err).slice(0, 200));
    }
    const path = new URL(url).pathname;
    if (!robotsAllows(rules, path)) throw new RobotsDisallowedError(path);
  }

  /**
   * RFC 9309 §2.3.1: a 2xx body is parsed; any 4xx (404 included) means no
   * restrictions; a 5xx or network error is thrown (the cache may then serve an
   * older copy, otherwise the feed is not requested).
   */
  private async fetchRobots(http: HttpClient): Promise<FeedFetchResult<RobotsRule[]>> {
    const response = await http.get<unknown>(SIMPLIFYJOBS_ROBOTS_URL, {
      responseType: 'text',
      maxContentLength: SIMPLIFYJOBS_ROBOTS_MAX_BYTES,
      headers: { Accept: 'text/plain' },
      validateStatus: (status: number) => status >= 200 && status < 500,
    });
    const rules =
      response.status >= 200 && response.status < 300
        ? parseRobotsTxt(bodyText(response.data), SIMPLIFYJOBS_ROBOTS_TOKEN)
        : [];
    return { status: 'fresh', value: rules, etag: null, maxAgeMs: null };
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bodyText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return '';
}

function hasDotSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function isValidRepo(value: string): boolean {
  return SIMPLIFYJOBS_REPO_RE.test(value) && !hasDotSegment(value);
}

export function isValidBranch(value: string): boolean {
  return SIMPLIFYJOBS_BRANCH_RE.test(value) && !hasDotSegment(value);
}

export function feedUrl(repo: string, branch: string): string {
  return `${SIMPLIFYJOBS_RAW_BASE}/${repo}/${branch}/${SIMPLIFYJOBS_FEED_PATH}`;
}

function buildFilter(input: ScraperInputDto, summerOnly: boolean, nowMs: number): SimplifyFilter {
  const hoursOld = input.hoursOld;
  const cutoffSeconds =
    typeof hoursOld === 'number' && Number.isFinite(hoursOld) && hoursOld > 0 ? nowMs / 1000 - hoursOld * 3600 : null;
  // `country` is deliberately ignored: it is a board-domain selector that
  // defaults to USA, and filtering on it would drop every UK and Canada row.
  return {
    tokens: tokenizeSearchTerm(input.searchTerm),
    location: buildLocationQuery(input.location),
    // `isRemote: false` is the input default, not a request for on-site rows.
    remoteOnly: input.isRemote === true,
    cutoffSeconds,
    summerOnly,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** The diagnostic one failed feed stands for. */
function diagnosticsForError(err: unknown): ScrapeDiagnostics {
  if (err instanceof SimplifyFeedFormatError) return new ScrapeDiagnostics('fetch_error', err.message.slice(0, MAX_DETAIL));
  if (err instanceof RobotsDisallowedError) return new ScrapeDiagnostics('blocked', err.message.slice(0, MAX_DETAIL));
  if (err instanceof RobotsUnreachableError) return new ScrapeDiagnostics('fetch_error', err.message.slice(0, MAX_DETAIL));
  return classifyScrapeError(err);
}

function allFailedDiagnostics(failed: SimplifyFeedOutcome[]): ScrapeDiagnostics {
  const first = diagnosticsForError(failed[0].error);
  if (failed.length === 1) return first;
  const detail = failed.map((o) => `${o.feed}: ${diagnosticsForError(o.error).detail ?? 'failed'}`).join('; ');
  return new ScrapeDiagnostics(first.reason, detail.slice(0, MAX_DETAIL));
}

/** `partial` when a feed failed or was served from an older copy; otherwise none. */
function partialDiagnostics(outcomes: SimplifyFeedOutcome[]): ScrapeDiagnostics | undefined {
  const notes: string[] = [];
  for (const o of outcomes) {
    if (o.source === 'failed') {
      const d = diagnosticsForError(o.error);
      notes.push(`${o.feed}: ${d.reason}: ${d.detail ?? 'failed'}`);
    } else if (o.source === 'stale') {
      const minutes = Math.floor((o.ageMs ?? 0) / 60_000);
      notes.push(`${o.feed}: served cached copy (age ${minutes}m) after ${errorMessage(o.error).slice(0, 200)}`);
    }
  }
  return notes.length > 0 ? new ScrapeDiagnostics('partial', notes.join('; ').slice(0, MAX_DETAIL)) : undefined;
}
