import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  decodeHtmlEntities,
  toDateOnly,
} from '@ever-jobs/common';
import {
  HEYRECRUIT_HOST_SUFFIX,
  HEYRECRUIT_HOST_TEMPLATE,
  HEYRECRUIT_JOBS_PATH,
  HEYRECRUIT_JOB_PATH_TEMPLATE,
  HEYRECRUIT_JOB_TILE_SELECTOR,
  HEYRECRUIT_JOB_TITLE_SELECTOR,
  HEYRECRUIT_JOB_CLICK_REGEX,
  HEYRECRUIT_JOB_ID_REGEX,
  HEYRECRUIT_LOCATION_ID_REGEX,
  HEYRECRUIT_DEFAULT_RESULTS,
  HEYRECRUIT_HEADERS,
} from './heyrecruit.constants';
import {
  HeyrecruitJob,
  HeyrecruitJobString,
  HeyrecruitCompanyLocation,
  HeyrecruitCompanyLocationJob,
  HeyrecruitTile,
} from './heyrecruit.types';

/**
 * Heyrecruit ATS careers scraper — generic, multi-tenant.
 *
 * Heyrecruit (heyrecruit.de) is a German "Performance Recruiting" ATS. Each
 * customer tenant publishes a branded, public, server-rendered careers portal at
 * `https://{subdomain}.heyrecruit.de/?page=jobs`. The platform's structured JSON
 * REST API (`app.heyrecruit.de/api/v2`) is gated behind a per-tenant JWT
 * (`client_id` / `client_secret`) and is deliberately NOT used.
 *
 * The public surface is the overview HTML: Heyrecruit's own template renders one
 * `<div class="job-tile">` per open role, and every tile anchor carries an inline
 * `onclick="jobClickEventListener({...json...})"` attribute embedding the
 * COMPLETE job record (the same object the REST `jobs/index` endpoint returns).
 * This adapter therefore:
 *
 *   1. Fetches the overview page once and loads it with cheerio.
 *   2. Harvests the embedded job object from each tile's
 *      `jobClickEventListener(...)` handler (decoding HTML entities first), and
 *      falls back to the visible tile text + detail anchor when that JSON is
 *      absent or malformed.
 *   3. Maps each job to a `JobPostDto`, de-duplicating by numeric job id.
 *
 * Tenant resolution: `companySlug` (the careers sub-domain label, e.g.
 * `bodenseetherme`) is preferred and expanded to
 * `https://{slug}.heyrecruit.de`; otherwise a fully qualified `companyUrl`
 * origin is used verbatim. A missing tenant, an HTTP error, or a malformed
 * payload degrades to an empty / partial result — never throws — so a single
 * tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.HEYRECRUIT,
  name: 'Heyrecruit',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HeyrecruitService implements IScraper {
  private readonly logger = new Logger(HeyrecruitService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Heyrecruit scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(input.companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Heyrecruit tenant host from input');
      return new JobResponseDto([]);
    }
    const fallbackCompanyName = this.deriveCompanyName(input.companySlug, host);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HEYRECRUIT_HEADERS);

    const resultsWanted = input.resultsWanted ?? HEYRECRUIT_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Heyrecruit job portal for host: ${host}`);

      const html = await this.fetchOverview(client, host);
      if (!html) {
        this.logger.warn(`Heyrecruit: no overview returned for ${host}`);
        return new JobResponseDto([]);
      }

      const tiles = this.parseOverview(html);
      this.logger.log(`Heyrecruit overview parsed: ${tiles.length} tiles for ${host}`);

      for (const tile of tiles) {
        try {
          const post = this.mapToJobPost(tile, host, fallbackCompanyName, input.descriptionFormat);
          if (!post) continue;
          // mapToJobPost guarantees a non-empty atsId (returns null otherwise).
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
          if (jobPosts.length >= resultsWanted) break;
        } catch (err: any) {
          this.logger.warn(`Heyrecruit: error mapping job tile: ${err.message}`);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Heyrecruit total: ${trimmed.length} jobs for ${host}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Heyrecruit scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch the public careers overview page. Returns null when the tenant is
   * unknown (HTTP 4xx) or the body is empty.
   */
  private async fetchOverview(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<string | null> {
    const url = `${host}${HEYRECRUIT_JOBS_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      return html || null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(`Heyrecruit tenant not found (HTTP ${status}) for ${host}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse the overview HTML into tiles. Each `<div class="job-tile">` yields its
   * embedded job record (from the `jobClickEventListener(...)` handler) plus the
   * visible title text and detail-page URL as layered fallbacks.
   */
  private parseOverview(html: string): HeyrecruitTile[] {
    const $ = cheerio.load(html);
    const tiles: HeyrecruitTile[] = [];

    $(HEYRECRUIT_JOB_TILE_SELECTOR).each((_i, el) => {
      try {
        const tile = this.parseTile($, el);
        if (tile) tiles.push(tile);
      } catch (err: any) {
        this.logger.warn(`Heyrecruit: error parsing job tile: ${err.message}`);
      }
    });

    return tiles;
  }

  /** Parse a single `<div class="job-tile">` into a {@link HeyrecruitTile}. */
  private parseTile($: cheerio.CheerioAPI, el: any): HeyrecruitTile | null {
    const $tile = $(el);

    // Primary source: the embedded job JSON in the onclick handler. Any anchor
    // in the tile carries the same payload; take the first that parses.
    let job: HeyrecruitJob | null = null;
    $tile.find('[onclick]').each((_j, anchor) => {
      if (job) return;
      const onclick = $(anchor).attr('onclick') ?? '';
      const parsed = this.extractEmbeddedJob(onclick);
      if (parsed) job = parsed;
    });

    // Fallback signals from the visible tile.
    const titleText = $tile.find(HEYRECRUIT_JOB_TITLE_SELECTOR).first().text().trim() || null;
    const detailUrl =
      $tile.find('a[href*="page=job"]').first().attr('href')?.trim() ||
      $tile.find('a[href]').first().attr('href')?.trim() ||
      null;

    if (!job && !titleText && !detailUrl) return null;
    return { job, titleText, detailUrl };
  }

  /**
   * Extract and JSON-parse the embedded job object from an inline
   * `jobClickEventListener({...})` handler. The attribute value is HTML-entity
   * encoded (e.g. `&quot;`), so it is decoded before parsing. Returns null when
   * no handler is present or the JSON is malformed.
   */
  private extractEmbeddedJob(onclick: string): HeyrecruitJob | null {
    const match = onclick.match(HEYRECRUIT_JOB_CLICK_REGEX);
    if (!match) return null;
    const raw = decodeHtmlEntities(match[1]);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as HeyrecruitJob;
    } catch {
      // Malformed embedded JSON — fall back to the visible tile text.
    }
    return null;
  }

  /** Map a parsed overview tile into a JobPostDto, or null when unusable. */
  private mapToJobPost(
    tile: HeyrecruitTile,
    host: string,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const job = tile.job;
    const str = this.defaultJobString(job);

    const title = (str?.title ?? tile.titleText ?? '').trim();
    if (!title) return null;

    const atsId = this.resolveAtsId(job, tile.detailUrl);
    if (!atsId) return null;

    const locationJob = this.primaryLocationJob(job);
    const locationId = this.resolveLocationId(locationJob, tile.detailUrl);
    const jobUrl = this.buildJobUrl(host, atsId, locationId, tile.detailUrl);

    const rawDescription = str?.description ?? null;
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    return new JobPostDto({
      id: `heyrecruit-${atsId}`,
      title,
      companyName: fallbackCompanyName,
      jobUrl,
      location: this.extractLocation(locationJob),
      description,
      datePosted: this.parseDate(this.resolveDate(job, locationJob)),
      isRemote: this.detectRemote(str, locationJob),
      emails: extractEmails(description),
      site: Site.HEYRECRUIT,
      atsId,
      atsType: 'heyrecruit',
      department: this.cleanString(str?.department),
      employmentType: this.cleanString(str?.employment),
      applyUrl: jobUrl,
    });
  }

  /**
   * Pick the default-language string bundle: the entry matching
   * `default_language_id` (or language id 1), else the first available bundle.
   */
  private defaultJobString(job: HeyrecruitJob | null): HeyrecruitJobString | null {
    const strings = Array.isArray(job?.job_strings) ? job!.job_strings! : [];
    if (strings.length === 0) return null;
    const preferredId = job?.default_language_id ?? 1;
    const preferred = strings.find(
      (s) => s && String(s.language_id ?? '') === String(preferredId),
    );
    return preferred ?? strings.find((s) => !!s) ?? null;
  }

  /** Pick the first active location join row, else the first available one. */
  private primaryLocationJob(job: HeyrecruitJob | null): HeyrecruitCompanyLocationJob | null {
    const rows = Array.isArray(job?.company_location_jobs) ? job!.company_location_jobs! : [];
    if (rows.length === 0) return null;
    return rows.find((r) => r && r.active) ?? rows.find((r) => !!r) ?? null;
  }

  /** Resolve the ATS id from the embedded job id, else the detail-URL id. */
  private resolveAtsId(job: HeyrecruitJob | null, detailUrl: string | null): string {
    const fromJob = job?.id != null ? String(job.id).trim() : '';
    if (fromJob) return fromJob;
    if (detailUrl) {
      const m = detailUrl.match(HEYRECRUIT_JOB_ID_REGEX);
      if (m) return m[1];
    }
    return '';
  }

  /** Resolve the company-location id from the join row, else the detail URL. */
  private resolveLocationId(
    locationJob: HeyrecruitCompanyLocationJob | null,
    detailUrl: string | null,
  ): string {
    const fromJob =
      locationJob?.company_location_id != null
        ? String(locationJob.company_location_id).trim()
        : '';
    if (fromJob) return fromJob;
    if (detailUrl) {
      const m = detailUrl.match(HEYRECRUIT_LOCATION_ID_REGEX);
      if (m) return m[1];
    }
    return '';
  }

  /**
   * Build the public job-detail URL. Prefers a fully-qualified embedded job +
   * location id; falls back to the tile's detail anchor (absolutised), then to
   * the overview page.
   */
  private buildJobUrl(
    host: string,
    atsId: string,
    locationId: string,
    detailUrl: string | null,
  ): string {
    if (atsId && locationId) {
      return `${host}${HEYRECRUIT_JOB_PATH_TEMPLATE.replace('{jobId}', encodeURIComponent(atsId)).replace(
        '{locationId}',
        encodeURIComponent(locationId),
      )}`;
    }
    if (detailUrl) {
      if (/^https?:\/\//i.test(detailUrl)) return detailUrl;
      return detailUrl.startsWith('/') ? `${host}${detailUrl}` : `${host}/${detailUrl}`;
    }
    if (atsId) {
      return `${host}/?page=job&id=${encodeURIComponent(atsId)}`;
    }
    return `${host}${HEYRECRUIT_JOBS_PATH}`;
  }

  /**
   * Resolve the tenant careers host from `companySlug` (the sub-domain label) or
   * from a fully-qualified `companyUrl` origin.
   */
  private resolveHost(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const label = companySlug.trim().toLowerCase();
      // A slug containing a dot is treated as a bare host / URL.
      if (label.includes('.')) {
        return /^https?:\/\//i.test(label) ? this.originOf(label) : this.originOf(`https://${label}`);
      }
      return HEYRECRUIT_HOST_TEMPLATE.replace('{subdomain}', encodeURIComponent(label));
    }
    if (companyUrl && companyUrl.trim()) {
      return this.originOf(companyUrl.trim());
    }
    return '';
  }

  /** Return the scheme+host origin of a URL string, or '' when malformed. */
  private originOf(url: string): string {
    try {
      const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      return `${u.protocol}//${u.host}`;
    } catch {
      return '';
    }
  }

  /** Derive a display company name from the slug or host sub-domain label. */
  private deriveCompanyName(companySlug: string | undefined, host: string): string {
    let base = companySlug?.trim();
    if (!base || base.includes('.')) {
      try {
        base = new URL(host).host.split('.')[0];
      } catch {
        base = host;
      }
    }
    return base
      .replace(/^https?:\/\//, '')
      .replace(new RegExp(`\\.${HEYRECRUIT_HOST_SUFFIX.replace('.', '\\.')}.*$`, 'i'), '')
      .replace(/\..*$/, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Build a LocationDto from the embedded company-location address. */
  private extractLocation(locationJob: HeyrecruitCompanyLocationJob | null): LocationDto | null {
    const loc: HeyrecruitCompanyLocation | null = locationJob?.company_location ?? null;
    if (!loc) return null;
    const city = this.cleanString(loc.city);
    const state = this.cleanString(loc.state);
    const country = this.cleanString(loc.country);
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Detect remote roles from the employment/department text. Heyrecruit's
   * structured model has no dedicated remote flag on the public tile, so we
   * inspect the localised employment/department labels for German/English cues.
   */
  private detectRemote(
    str: HeyrecruitJobString | null,
    locationJob: HeyrecruitCompanyLocationJob | null,
  ): boolean {
    const haystacks = [
      str?.employment,
      str?.department,
      str?.title,
      locationJob?.company_location?.title,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('homeoffice') ||
        v.includes('home office') ||
        v.includes('remote') ||
        v.includes('mobiles arbeiten') ||
        v.includes('work from home')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Prefer the location join's publish_date, then the job-level timestamps. */
  private resolveDate(
    job: HeyrecruitJob | null,
    locationJob: HeyrecruitCompanyLocationJob | null,
  ): string | null {
    return (
      this.cleanString(locationJob?.publish_date) ??
      this.cleanString(job?.publication_date) ??
      this.cleanString(job?.last_modification)
    );
  }

  /**
   * Parse an ISO-8601 timestamp (e.g. "2026-06-01T14:51:06+02:00") into a
   * `YYYY-MM-DD` string. Returns null for null/undefined or unparseable inputs.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value.trim());
      if (!isNaN(parsed.getTime())) return toDateOnly(value.trim());
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a possibly-null string to a non-empty value, or null. */
  private cleanString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }
}
