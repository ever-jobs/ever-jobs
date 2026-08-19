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
} from '@ever-jobs/common';
import {
  RADANCY_HOST_SUFFIX,
  RADANCY_DEFAULT_LANG,
  RADANCY_RESULTS_PATH,
  RADANCY_PAGE_SIZE,
  RADANCY_DEFAULT_RESULTS,
  RADANCY_MAX_PAGES,
  RADANCY_DEFAULT_TIMEOUT_SECONDS,
  RADANCY_HEADERS,
  RADANCY_REMOTE_REGEX,
  radancyCareerOrigin,
} from './radancy.constants';
import { RadancyJob, RadancyJobTile, RadancyResultsResponse } from './radancy.types';

/**
 * Radancy (TalentBrew) ATS careers scraper — generic, multi-tenant.
 *
 * Radancy (radancy.com — the enterprise Talent Acquisition Cloud, formerly TMP Worldwide;
 * its branded career sites are marketed as **TalentBrew**) powers each customer's public,
 * unauthenticated candidate-facing career site. Radancy is **hostname-multi-tenant**: each
 * customer's site lives on its own host (a vanity `careers.{brand}.com`, a `{brand}.jobs`
 * host, or the demo board `jobs.radancy.com`), all running the same TalentBrew front-end and
 * exposing the same public, anonymous job-results endpoint:
 *
 *   GET https://{host}/{lang}/search-jobs/results?ActiveFacetID=0&CurrentPage={n}&RecordsPerPage={k}&FacetType=0
 *
 * which returns a small JSON envelope `{ filters, results, hasJobs, hasContent }`. The
 * `results` value is a **server-rendered HTML fragment** — a `<ul>` of job tiles, each an
 * `<li>` with an `<a class="links-with-hover-lines__link" href="/{lang}/job/{location}/{slug}/{orgId}/{jobId}"
 * data-job-id="{jobId}">{title}</a>`, a sibling `<span class="job-location">{location}</span>`,
 * and a `<button … data-org-id="{orgId}">` save control. The adapter GETs this feed, parses
 * the per-role anchor + location out of the `results` HTML, walks `CurrentPage` until a page
 * yields no tiles (or `hasJobs` is false), and maps each role — rather than depending on a
 * client-rendered DOM, a headless browser, or an authenticated Radancy/ATS API. The role's
 * `data-job-id` is the stable ATS id, and the anchor href (resolved against the tenant host)
 * is the canonical public detail / apply page.
 *
 * The caller addresses a tenant by `companyUrl` (any TalentBrew career-site URL — its host is
 * the tenant) or by `companySlug` (treated as a host: a bare host is used as-is; a bare
 * dot-less label is expanded to the Radancy demo convention `{label}.radancy.com` as a
 * best-effort default). An unknown host, a board with no open roles, a DNS failure, an HTTP
 * error, or a malformed body degrades naturally to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 *
 * Surface confidence: verified live 2026-06-03 against `jobs.radancy.com` (org id `47123`,
 * real job tiles parsed) and the envelope shape re-confirmed on `careers.aldi.us`. The JSON
 * envelope + endpoint + URL shape are verified; the per-tile HTML class names can drift
 * across TalentBrew template versions, so the parser is intentionally defensive.
 */
@SourcePlugin({
  site: Site.RADANCY,
  name: 'Radancy',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RadancyService implements IScraper {
  private readonly logger = new Logger(RadancyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Radancy scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Radancy tenant host from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive TalentBrew host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? RADANCY_DEFAULT_TIMEOUT_SECONDS,
      RADANCY_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(RADANCY_HEADERS);

    const resultsWanted = input.resultsWanted ?? RADANCY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Radancy jobs for host: ${host}`);

      const companyName = this.deriveHostName(host);
      const seen = new Set<string>();

      // Drain the paginated public results feed up to the page cap or until we've collected
      // `resultsWanted` roles. A transport-level failure (host unreachable) aborts the sweep;
      // an HTTP error / malformed page / empty page degrades to an empty / partial result.
      for (let page = 1; page <= RADANCY_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, host, page);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        // The board explicitly reports no roles → stop.
        if (body.hasJobs === false) break;

        const tiles = this.parseTiles(body.results);
        if (tiles.length === 0) break; // empty page → end of the paginator

        for (const tile of tiles) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processTile(tile, host, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Radancy role ${tile?.jobId}: ${err.message}`);
          }
        }

        // A short page (fewer tiles than requested) means we have reached the last page.
        if (tiles.length < RADANCY_PAGE_SIZE) break;
      }

      this.logger.log(`Radancy total: ${jobPosts.length} jobs for ${host}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Radancy scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET one page of the tenant's public results feed as JSON. Returns
   * `{ data, hostReachable }`:
   *  - `data` is the parsed `{ filters, results, hasJobs, hasContent }` envelope, or null
   *    when the response carried no usable JSON / the host answered an HTTP error status
   *    (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the tenant host itself is unreachable and the caller should
   *    stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    page: number,
  ): Promise<{ data: RadancyResultsResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(host, page);
    try {
      const response = await client.get<RadancyResultsResponse | string>(url);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-host / 5xx) — it is reachable, but
        // there is nothing more to drain.
        this.logger.warn(`Radancy feed returned HTTP ${status} for ${host}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Radancy feed fetch failed for ${host}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed results envelope. The client usually parses
   * the JSON for us (object body); if a tenant serves the feed as a text/plain string we
   * parse it ourselves. A non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(data: RadancyResultsResponse | string | unknown): RadancyResultsResponse | null {
    if (data && typeof data === 'object') return data as RadancyResultsResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as RadancyResultsResponse;
      } catch (err: any) {
        this.logger.warn(`Radancy feed JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Parse the `results` HTML fragment into a list of job tiles. Each `<li>` job tile carries
   * an `<a … href data-job-id>{title}</a>` and a sibling `<span class="job-location">`. The
   * parser is regex-based and defensive: it scans for every job anchor and reads the nearby
   * location + org-id, tolerating template drift. A non-HTML / empty fragment yields `[]`.
   */
  private parseTiles(results: string | null | undefined): RadancyJobTile[] {
    if (typeof results !== 'string') return [];
    const html = results.trim();
    if (!html) return [];

    const tiles: RadancyJobTile[] = [];

    // Match each job anchor: capture href + data-job-id (in either attribute order) + inner
    // text (the title). TalentBrew emits a `data-job-id` on the role anchor.
    const anchorRe =
      /<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*?\bdata-job-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|<a\b[^>]*?\bdata-job-id=["']([^"']+)["'][^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = anchorRe.exec(html)) !== null) {
      const href = match[1] ?? match[5] ?? null;
      const jobId = match[2] ?? match[4] ?? null;
      const inner = match[3] ?? match[6] ?? null;
      if (!jobId || !href) continue;

      const title = this.stripTags(inner);

      // Look ahead a bounded window past this anchor for the adjacent location span and the
      // save-button's org id.
      const tail = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 600);
      const location = this.matchFirst(
        tail,
        /<span\b[^>]*\bclass=["'][^"']*\bjob-location\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      );
      const orgId =
        this.matchFirst(tail, /\bdata-org-id=["']([^"']+)["']/i) ??
        this.orgIdFromHref(href);

      tiles.push({
        jobId,
        orgId,
        title,
        href,
        location: location ? this.stripTags(location) : null,
      });
    }

    return tiles;
  }

  /** Map a parsed tile → JobPostDto, deduping by ATS id. */
  private processTile(
    tile: RadancyJobTile,
    host: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseTile(tile, host, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, host, format);
  }

  /** Build a normalised RadancyJob from a parsed tile. */
  private normaliseTile(
    tile: RadancyJobTile,
    host: string,
    companyName: string,
  ): RadancyJob | null {
    const atsId = this.cleanText(tile.jobId);
    if (!atsId) return null;

    const href = this.cleanText(tile.href);
    if (!href) return null;
    const url = this.absoluteUrl(host, href);
    const title = this.cleanText(tile.title);
    const locationText = this.cleanText(tile.location);

    return {
      atsId,
      url,
      // The TalentBrew detail page hosts the apply flow; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: companyName || this.deriveHostName(host),
      locationText,
      isRemote: this.detectRemote(title, locationText),
    };
  }

  /** Map a normalised RadancyJob → JobPostDto. */
  private processJob(
    job: RadancyJob,
    host: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveHostName(host);
    // The list fragment carries no description body (it lives on the unfetched detail page);
    // surface a null description, still format-normalised for shape consistency.
    const description = this.formatDescription(null, format);

    return new JobPostDto({
      id: `radancy-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.RADANCY,
      atsId,
      atsType: 'radancy',
      department: null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. The Radancy list fragment
   * carries no body, but the converter is wired for shape parity with the sibling adapters
   * (and for a future detail-page enrichment): HTML returns it as-is, Markdown converts it,
   * Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant host. An explicit `companySlug` is treated as a host: a value that is
   * already a URL / contains a dot is reduced to its hostname; a bare dot-less label is
   * expanded to the Radancy demo convention `{label}.radancy.com`. A `companyUrl` yields its
   * hostname directly. Returns an empty string when neither yields a host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes('.')) {
        const fromUrl = this.hostFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // Bare label → best-effort Radancy-managed host.
      return `${slug.toLowerCase()}${RADANCY_HOST_SUFFIX}`;
    }
    if (companyUrl) {
      const fromUrl = this.hostFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /** Derive the bare hostname from a career-site URL (or bare host) value. */
  private hostFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      return hostname || '';
    } catch {
      // Malformed URL — no host.
    }
    return '';
  }

  /** Assemble a tenant's public results-feed URL for a given page. */
  private buildFeedUrl(host: string, page: number): string {
    const origin = radancyCareerOrigin(host);
    const params = new URLSearchParams({
      ActiveFacetID: '0',
      CurrentPage: String(page),
      RecordsPerPage: String(RADANCY_PAGE_SIZE),
      FacetType: '0',
    });
    return `${origin}/${RADANCY_DEFAULT_LANG}/${RADANCY_RESULTS_PATH}?${params.toString()}`;
  }

  /** Resolve a (possibly relative) anchor href against the tenant host into an absolute URL. */
  private absoluteUrl(host: string, href: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    const origin = radancyCareerOrigin(host);
    const path = href.startsWith('/') ? href : `/${href}`;
    return `${origin}${path}`;
  }

  /**
   * Extract the tenant org id from a canonical detail href when the save-button id is absent.
   * The detail path shape is `/{lang}/job/{location}/{slug}/{orgId}/{jobId}` — the org id is
   * the second-to-last numeric segment.
   */
  private orgIdFromHref(href: string): string | null {
    const m = /\/job\/[^?#]*?\/(\d+)\/(\d+)(?:[/?#]|$)/i.exec(href);
    return m ? m[1] : null;
  }

  /** De-slugify the host's leading label into a display company name. */
  private deriveHostName(host: string): string {
    const label = host.split('.')[0] || host;
    const base = label && label.trim() ? label.trim() : label;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location as a LocationDto. The list fragment carries a single
   * free-text line (e.g. `Atlanta, Georgia`); split it into city / state when comma-separated,
   * leaving location null when nothing usable is present.
   */
  private extractLocation(job: RadancyJob): LocationDto | null {
    const text = job.locationText;
    if (!text) return null;
    const parts = text.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) return null;
    const city = parts[0] ?? null;
    const state = parts.length > 1 ? parts[1] : null;
    const country = parts.length > 2 ? parts[parts.length - 1] : null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title or location text. */
  private detectRemote(title: string | null, location: string | null): boolean {
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (RADANCY_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** First capture-group of a regex against a string, trimmed, else null. */
  private matchFirst(haystack: string, re: RegExp): string | null {
    const m = re.exec(haystack);
    const v = m?.[1];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  }

  /** Strip HTML tags + collapse whitespace + decode the few common entities. */
  private stripTags(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const text = value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 0 ? text : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
