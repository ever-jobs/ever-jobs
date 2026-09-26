import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  ScrapeDiagnostics,
} from '@ever-jobs/models';
import {
  createHttpClient,
  decodeHtmlEntities,
  extractEmails,
  htmlToPlainText,
  markdownConverter,
  parseLocationList,
  postedFromTimestamp,
  postedTimeFields,
  PostedTime,
} from '@ever-jobs/common';
import {
  REMOTEOK_API_URL,
  REMOTEOK_BASE_URL,
  REMOTEOK_CRAWL_DELAY_S,
  REMOTEOK_DEFAULT_LIMIT,
  REMOTEOK_HEADERS,
  REMOTEOK_LEGACY_UA_CRAWL_POLICY,
  REMOTEOK_LEGACY_USER_AGENT,
  REMOTEOK_USER_AGENT,
  REMOTEOK_HOSTS,
  REMOTEOK_LEGACY_ENV,
  REMOTEOK_MAX_LIMIT,
  REMOTEOK_RATE_DELAY_MAX_S,
  REMOTEOK_RATE_DELAY_MIN_S,
} from './remoteok.constants';
import {
  buildMatchFields,
  cleanTitle,
  collapseWhitespace,
  legacyCompensation,
  legacyPhraseMatch,
  matchTier,
  normalizeUrl,
  parseFeedPayload,
  parseLegacyMode,
  pickTagSeed,
  plausibleCompensation,
  repairMojibake,
  resolveApplyUrls,
  resolveJobUrl,
  RemoteOkLegacyPart,
  tidyLocation,
  tokenizeSearchTerm,
} from './remoteok.text';
import { RemoteOkJob } from './remoteok.types';

type HttpClient = ReturnType<typeof createHttpClient>;
type Legacy = ReadonlySet<RemoteOkLegacyPart>;

/** Messages that mean "slow down": never answered with a second request. */
const RATE_LIMITED = /\b429\b|too many requests|rate[ -]?limit/i;

/** One feed row with its text repaired once, for matching and mapping. */
interface PreparedEntry {
  entry: RemoteOkJob;
  title: string;
  company: string;
  location: string;
  /** HTML, repaired. */
  description: string;
  tags: string[];
  /** Plain text of `description`, computed at most once. */
  plain?: string;
}

@SourcePlugin({
  site: Site.REMOTEOK,
  name: 'RemoteOK',
  category: 'remote',
})
@Injectable()
export class RemoteOkService implements IScraper {
  private readonly logger = new Logger(RemoteOkService.name);

  /**
   * Spec 1707: one request to the tag feed picked from the search term (the
   * global feed only holds the latest ~100 postings across every category),
   * falling back to the global feed when the tag is unknown or its request
   * fails; then repair, `hoursOld`, whole-word AND matching with title-first
   * ranking, and `offset` / `resultsWanted` applied locally. At most two
   * sequential requests, spaced by the site's crawl delay.
   */
  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const legacyMode = parseLegacyMode(process.env[REMOTEOK_LEGACY_ENV]);
    const legacy = legacyMode.parts;
    const limit = resolveLimit(input.resultsWanted);
    const offset = resolveOffset(input.offset);
    const nowMs = Date.now();
    const tokens = legacy.has('search') ? [] : tokenizeSearchTerm(input.searchTerm);
    const seed = legacy.has('search') ? null : pickTagSeed(tokens);

    this.logger.log(
      `RemoteOK scrape: search="${input.searchTerm ?? ''}" limit=${limit} offset=${offset}` +
        (legacy.size > 0 ? ` legacy=${[...legacy].join(',')}` : ''),
    );
    if (legacyMode.unknown.length > 0) {
      this.logger.warn(`RemoteOK: ignoring unknown ${REMOTEOK_LEGACY_ENV} value(s): ${legacyMode.unknown.join(', ')}`);
    }

    try {
      const spacing = crawlSpacing(input.rateDelayMin, input.rateDelayMax);
      const http = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        userAgent: input.userAgent,
        // Both spellings: the input-shaped branch of createHttpClient reads
        // `requestTimeout`, the options branch reads `timeout`.
        requestTimeout: input.requestTimeout,
        timeout: input.requestTimeout,
        retries: input.retries,
        retryDelay: input.retryDelay,
        retryBackoff: input.retryBackoff,
        retryMaxDelay: input.retryMaxDelay,
        ...spacing,
        // The spacing is also a floor no crawl-policy layer shortens: since Spec 1690
        // rateDelayMin is only the plugin layer, which a caller override replaces.
        minIntervalFloorMs: spacing.rateDelayMin * 1000,
        // EVER_JOBS_REMOTEOK_LEGACY=ua: let the declared browser UA reach the wire
        // under the default identify mode (an operator or caller strict still wins).
        ...(legacy.has('ua') ? { crawl: REMOTEOK_LEGACY_UA_CRAWL_POLICY } : {}),
        allowedRedirectHosts: REMOTEOK_HOSTS,
      });
      const headers = buildHeaders(input.userAgent, legacy.has('ua'));

      let entries: RemoteOkJob[] | null = null;
      let feed = 'global';
      let tagError: unknown = null;

      if (seed) {
        try {
          const tagged = await this.fetchFeed(http, headers, seed);
          if (tagged.length > 0) {
            entries = tagged;
            feed = `tag:${seed}`;
          } else {
            this.logger.debug(`RemoteOK: tag feed "${seed}" returned no jobs; using the global feed`);
          }
        } catch (err: unknown) {
          const diagnostics = classifyScrapeError(err);
          if (diagnostics.reason === 'blocked' || RATE_LIMITED.test(diagnostics.detail ?? '')) {
            // Asking again after a block or a rate limit is exactly what the
            // crawl policy rules out.
            this.logger.warn(`RemoteOK tag feed "${seed}" refused (${diagnostics.reason}): ${errorMessage(err)}`);
            return new JobResponseDto([], diagnostics);
          }
          tagError = err;
          this.logger.warn(`RemoteOK tag feed "${seed}" failed: ${errorMessage(err)}; trying the global feed`);
        }
      }

      if (entries === null) {
        try {
          entries = await this.fetchFeed(http, headers);
        } catch (err: unknown) {
          this.logger.error(`RemoteOK scrape error: ${errorMessage(err)}`);
          return new JobResponseDto([], classifyScrapeError(err));
        }
      }

      const prepared = entries.map((entry) => prepareEntry(entry, legacy));
      const fresh = filterByHoursOld(prepared, input.hoursOld, nowMs);
      const matched = legacy.has('search')
        ? fresh.filter((p) => !input.searchTerm || legacyPhraseMatch(p.title, p.tags, input.searchTerm))
        : rankByTokens(fresh, tokens);
      const page = matched.slice(offset, offset + limit);

      this.logger.log(
        `RemoteOK: feed=${feed} fetched=${entries.length} afterHours=${fresh.length} ` +
          `matched=${matched.length} returned=${page.length}`,
      );

      const jobs: JobPostDto[] = [];

      for (const item of page) {
        try {
          const job = this.mapJob(item, input.descriptionFormat, legacy, nowMs);
          if (job) {
            jobs.push(job);
          }
        } catch (err: unknown) {
          this.logger.warn(`Error mapping RemoteOK job ${String(item.entry.id)}: ${errorMessage(err)}`);
        }
      }

      if (tagError !== null) {
        // A failed recall path must not hide behind a plain empty result.
        if (jobs.length === 0) return new JobResponseDto([], classifyScrapeError(tagError));
        return new JobResponseDto(
          jobs,
          new ScrapeDiagnostics(
            'partial',
            `tag feed "${seed}" failed: ${errorMessage(tagError).slice(0, 200)}; served global feed`,
          ),
        );
      }

      return new JobResponseDto(jobs);
    } catch (err: unknown) {
      this.logger.error(`RemoteOK scrape error: ${errorMessage(err)}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private async fetchFeed(http: HttpClient, headers: Record<string, string>, tag?: string): Promise<RemoteOkJob[]> {
    const response = await http.get<unknown>(REMOTEOK_API_URL, {
      headers,
      ...(tag ? { params: { tag } } : {}),
    });
    return parseFeedPayload(response.data);
  }

  /**
   * Map a prepared RemoteOK row to a JobPostDto.
   */
  private mapJob(
    item: PreparedEntry,
    descriptionFormat: DescriptionFormat | undefined,
    legacy: Legacy,
    nowMs: number,
  ): JobPostDto | null {
    const { entry } = item;

    let jobUrl: string | null;
    let applyUrl: string | null;
    let jobUrlDirect: string | null;
    if (legacy.has('urls')) {
      jobUrl = entry.url || null;
      applyUrl = entry.apply_url || null;
      jobUrlDirect = applyUrl;
    } else {
      jobUrl = resolveJobUrl(entry, REMOTEOK_BASE_URL);
      const resolved = jobUrl ? resolveApplyUrls(entry.apply_url, jobUrl, REMOTEOK_BASE_URL) : null;
      applyUrl = resolved?.applyUrl ?? null;
      jobUrlDirect = resolved?.jobUrlDirect ?? null;
    }

    if (!item.title || !jobUrl) {
      return null;
    }

    // Process description (RemoteOK returns HTML)
    let description: string | null = item.description || null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = plainTextOf(item);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    const compensation = this.compensationOf(entry, legacy);

    // Build location
    const locationParsed = parseLocationList([
      legacy.has('location') ? item.location || null : tidyLocation(item.location),
    ]);
    const location = locationParsed.location;

    return new JobPostDto({
      id: `remoteok-${entry.id}`,
      title: item.title,
      companyName: item.company || null,
      companyLogo: legacy.has('urls') ? entry.company_logo || null : logoOf(entry),
      jobUrl,
      jobUrlDirect,
      applyUrl,
      location,
      ...(locationParsed.locations.length > 0 ? { locations: locationParsed.locations } : {}),
      description,
      compensation,
      ...postedTimeFields(postedTimeOf(entry, nowMs)),
      isRemote: true,
      emails: extractEmails(description),
      site: Site.REMOTEOK,
      skills: item.tags.length > 0 ? item.tags : null,
    });
  }

  private compensationOf(entry: RemoteOkJob, legacy: Legacy): CompensationDto | null {
    if (legacy.has('salary')) return legacyCompensation(entry.salary_min, entry.salary_max);
    const compensation = plausibleCompensation(entry.salary_min, entry.salary_max);
    if (!compensation && (Number(entry.salary_min) > 0 || Number(entry.salary_max) > 0)) {
      this.logger.debug(
        `RemoteOK job ${String(entry.id)}: implausible salary ${String(entry.salary_min)}-${String(entry.salary_max)} dropped`,
      );
    }
    return compensation;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

function resolveLimit(resultsWanted: number | undefined): number {
  const wanted = typeof resultsWanted === 'number' && Number.isFinite(resultsWanted) ? resultsWanted : REMOTEOK_DEFAULT_LIMIT;
  return Math.min(REMOTEOK_MAX_LIMIT, Math.max(1, Math.floor(wanted)));
}

function resolveOffset(offset: number | undefined): number {
  return typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
}

/**
 * Client spacing in seconds: the caller's values, never below the site's
 * `Crawl-delay`, and a maximum no smaller than the minimum.
 */
function crawlSpacing(
  rateDelayMin: number | undefined,
  rateDelayMax: number | undefined,
): { rateDelayMin: number; rateDelayMax: number } {
  const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  const min = Math.max(REMOTEOK_CRAWL_DELAY_S, finite(rateDelayMin) ? rateDelayMin : REMOTEOK_RATE_DELAY_MIN_S);
  const max = Math.max(min, finite(rateDelayMax) ? rateDelayMax : REMOTEOK_RATE_DELAY_MAX_S);
  return { rateDelayMin: min, rateDelayMax: max };
}

/**
 * The constant headers, with a caller-supplied User-Agent taking precedence.
 * `legacyUa` (EVER_JOBS_REMOTEOK_LEGACY=ua) sends the pre-1707 browser UA.
 */
function buildHeaders(userAgent: string | undefined, legacyUa = false): Record<string, string> {
  const ua = typeof userAgent === 'string' ? userAgent.trim() : '';
  const fallback = legacyUa ? REMOTEOK_LEGACY_USER_AGENT : REMOTEOK_USER_AGENT;
  return { ...REMOTEOK_HEADERS, 'User-Agent': ua || fallback };
}

/**
 * Repair every text field once. Plain-text fields (title, company, location,
 * tags) also get their HTML entities decoded (`R&amp;S`); the description
 * stays HTML. `legacy text` keeps every field exactly as the feed sent it.
 */
function prepareEntry(entry: RemoteOkJob, legacy: Legacy): PreparedEntry {
  const verbatim = legacy.has('text');
  const html = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return verbatim ? value : repairMojibake(value);
  };
  const plain = (value: unknown): string => {
    const text = html(value);
    return verbatim || !text.includes('&') ? text : decodeHtmlEntities(text);
  };
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(plain)
    : [];
  return {
    entry,
    title: verbatim ? html(entry.position) : cleanTitle(plain(entry.position)),
    company: verbatim ? html(entry.company) : collapseWhitespace(plain(entry.company)),
    location: plain(entry.location),
    description: html(entry.description),
    tags,
  };
}

function plainTextOf(item: PreparedEntry): string {
  if (item.plain === undefined) item.plain = item.description ? htmlToPlainText(item.description) : '';
  return item.plain;
}

/** Posting instant in epoch seconds: `epoch`, else `date`; `null` when neither is usable. */
function postedEpochSeconds(entry: RemoteOkJob): number | null {
  const epoch = Number(entry.epoch);
  if (entry.epoch !== undefined && entry.epoch !== null && Number.isFinite(epoch) && epoch > 0) return epoch;
  if (typeof entry.date === 'string') {
    const ms = Date.parse(entry.date);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

/** `hoursOld` cut-off; rows with no usable date are kept, as sibling boards do. */
function filterByHoursOld(items: PreparedEntry[], hoursOld: number | undefined, nowMs: number): PreparedEntry[] {
  if (typeof hoursOld !== 'number' || !Number.isFinite(hoursOld) || hoursOld <= 0) return items;
  const cutoff = nowMs / 1000 - hoursOld * 3600;
  return items.filter((item) => {
    const posted = postedEpochSeconds(item.entry);
    return posted === null || posted >= cutoff;
  });
}

/** Keep rows matching every token, ordered by tier; feed order (newest first) within a tier. */
function rankByTokens(items: PreparedEntry[], tokens: readonly string[]): PreparedEntry[] {
  if (tokens.length === 0) return items;
  const tiers: PreparedEntry[][] = [[], [], []];
  for (const item of items) {
    const tier = matchTier(buildMatchFields(item.title, item.company, plainTextOf(item), item.tags), tokens);
    if (tier !== null) tiers[tier].push(item);
  }
  return tiers.flat();
}

/**
 * `date` (ISO with offset) first: it keeps the source's calendar day. `epoch`
 * is the fallback when `date` is missing or gives no confident instant.
 */
function postedTimeOf(entry: RemoteOkJob, nowMs: number): PostedTime {
  const fromDate = postedFromTimestamp(entry.date ?? null, nowMs);
  if (fromDate.datePostedPrecision !== null) return fromDate;
  const epoch = Number(entry.epoch);
  if (entry.epoch !== undefined && entry.epoch !== null && Number.isFinite(epoch) && epoch > 0) {
    const fromEpoch = postedFromTimestamp(epoch, nowMs);
    if (fromEpoch.datePosted !== null) return fromEpoch;
  }
  return fromDate;
}

/** The employer's logo (never the board's), `company_logo` then `logo`; both are usually empty. */
function logoOf(entry: RemoteOkJob): string | null {
  return normalizeUrl(entry.company_logo, REMOTEOK_BASE_URL) ?? normalizeUrl(entry.logo, REMOTEOK_BASE_URL);
}
