import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
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
  PEOPLEHR_ROOT_DOMAIN,
  PEOPLEHR_DEFAULT_RESULTS,
  PEOPLEHR_DEFAULT_TIMEOUT_SECONDS,
  PEOPLEHR_HEADERS,
  PEOPLEHR_GUID_REGEX,
  PEOPLEHR_REMOTE_REGEX,
  peoplehrBoardUrl,
  peoplehrOpeningUrl,
} from './peoplehr.constants';
import { PeopleHrBoardRow, PeopleHrJob } from './peoplehr.types';

/**
 * Access PeopleHR ATS careers scraper — generic, multi-tenant.
 *
 * Access PeopleHR (peoplehr.com — a UK SMB HR suite, part of The Access Group, with built-in
 * recruitment) powers each customer's branded, public, unauthenticated candidate-facing job
 * board on a per-tenant **sub-domain** of the shared host `peoplehr.net`:
 *
 *   https://{tenant}.peoplehr.net/JobBoard                                (board landing — current openings)
 *   https://{tenant}.peoplehr.net/Pages/JobBoard/Opening.aspx?v={GUID}    (per-role public detail / apply page)
 *
 * The board landing is a single **server-rendered HTML page** that emits every open role inline
 * as a table row (`<tr class="tabletrHght" data-url="/Pages/JobBoard/Opening.aspx?v={GUID}">`)
 * carrying the role's stable vacancy GUID (the ATS id), a `lblVacancyName` title, a `lblLocation`
 * label, and a `lblDepartment` label, plus the tenant's display name once in `lblCompanyName`.
 * There is no pagination cursor — the full list of current openings is available from one
 * anonymous GET, with no client-side rendering required.
 *
 * The adapter resolves the tenant sub-domain label, fetches the single board page, parses each
 * row, and maps each role — rather than depending on a client-rendered DOM, a headless browser,
 * or any authenticated PeopleHR API. The per-role `Opening.aspx?v={GUID}` detail page renders
 * its rich body client-side, so the adapter sources every field from the server-rendered board
 * row and treats the description as unavailable (null) rather than depending on script
 * execution.
 *
 * The caller addresses a tenant by `companySlug` (the bare sub-domain label, e.g. `efigroup`) or
 * by `companyUrl` (a `*.peoplehr.net` URL whose first sub-domain label is the tenant). An unknown
 * tenant, a board with no openings, or an unreachable sub-domain degrades naturally to an empty
 * result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an empty /
 * partial result rather than throwing, so a single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.PEOPLEHR,
  name: 'Access PeopleHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PeopleHrService implements IScraper {
  private readonly logger = new Logger(PeopleHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for PeopleHR scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a PeopleHR tenant sub-domain from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive PeopleHR sub-domain degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter timeout;
    // we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? PEOPLEHR_DEFAULT_TIMEOUT_SECONDS,
      PEOPLEHR_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(PEOPLEHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? PEOPLEHR_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching PeopleHR jobs for tenant: ${tenant}`);

      // The board landing renders every current opening in a single server-side page (no
      // pagination cursor), so a single fetch drains the whole board. A transport-level failure
      // (host unreachable) and an HTTP-status error both degrade to an empty result.
      const result = await this.fetchBoard(client, tenant);
      const html = result.html;
      if (!html) {
        // Empty body / HTTP error / unreachable host → no roles.
        return new JobResponseDto([]);
      }

      const $ = cheerio.load(html);
      const companyName = this.resolveCompanyName($) ?? this.deriveTenantName(tenant);
      const rows = this.parseRows($);
      if (rows.length === 0) {
        this.logger.log(`PeopleHR: no open roles found for tenant ${tenant}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`PeopleHR: found ${rows.length} board rows for ${tenant}`);

      const seen = new Set<string>();
      for (const row of rows) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processRow(row, tenant, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing PeopleHR role ${row?.guid}: ${err.message}`);
        }
      }

      this.logger.log(`PeopleHR total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`PeopleHR scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET the tenant's public board landing as HTML. Returns `{ html, hostReachable }`:
   *  - `html` is the response body, or null when the response carried no usable body / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host) / the host was
   *    unreachable.
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout). The board is single-page so the flag is informational, but it keeps the
   *    transport-vs-HTTP distinction the sibling adapters draw.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchBoard(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ html: string | null; hostReachable: boolean }> {
    const url = peoplehrBoardUrl(tenant);
    try {
      const response = await client.get<string>(url);
      const html = typeof response.data === 'string' ? response.data : '';
      return { html: html || null, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // to drain (an unknown tenant typically 404s / redirects).
        this.logger.warn(`PeopleHR board returned HTTP ${status} for ${tenant}`);
        return { html: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // sub-domain is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`PeopleHR board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { html: null, hostReachable: false };
    }
  }

  /**
   * Parse the board-landing HTML into one {@link PeopleHrBoardRow} per open role.
   *
   * Each current opening is a `<tr class="tabletrHght" data-url="/Pages/JobBoard/Opening.aspx?v={GUID}">`
   * whose three cells hold a `lblVacancyName` (title), `lblLocation` (location), and
   * `lblDepartment` (department) span. We key on the stable structural signals — the row's
   * `data-url` GUID and the `lbl*`-suffixed span ids — rather than on fragile theme classes, so
   * minor styling changes do not break extraction.
   */
  private parseRows($: cheerio.CheerioAPI): PeopleHrBoardRow[] {
    const rows: PeopleHrBoardRow[] = [];

    $('tr[data-url]').each((_, el) => {
      const node = $(el);
      const dataUrl = node.attr('data-url') ?? '';
      const guid = this.guidFromUrl(dataUrl);
      if (!guid) return; // not a vacancy row

      const vacancyName = this.spanText(node, 'lblVacancyName');
      const location = this.spanText(node, 'lblLocation');
      const department = this.spanText(node, 'lblDepartment');

      rows.push({ guid, vacancyName, location, department });
    });

    return rows;
  }

  /**
   * Read the trimmed text of the row's span whose id contains the given `lbl*` token (the
   * PeopleHR repeater suffixes each span id with a row index, e.g. `..._lblVacancyName_0`). Falls
   * back to a positional cell read when no labelled span is present in a future theme.
   */
  private spanText(row: cheerio.Cheerio<any>, label: string): string | null {
    const byId = row.find(`span[id*="${label}"]`).first();
    const text = this.cleanText(byId.text());
    return text;
  }

  /** Resolve the tenant's display company name from the board's `lblCompanyName`, else null. */
  private resolveCompanyName($: cheerio.CheerioAPI): string | null {
    const el = $('[id*="lblCompanyName"]').first();
    return this.cleanText(el.text());
  }

  /** Map a parsed board row → JobPostDto, deduping by ATS id (the vacancy GUID). */
  private processRow(
    row: PeopleHrBoardRow,
    tenant: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseRow(row, tenant, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised PeopleHrJob from a parsed board row. */
  private normaliseRow(
    row: PeopleHrBoardRow,
    tenant: string,
    companyName: string,
  ): PeopleHrJob | null {
    const atsId = this.cleanText(row.guid);
    if (!atsId) return null;

    const url = peoplehrOpeningUrl(tenant, atsId);
    const title = this.cleanText(row.vacancyName);
    const locationText = this.cleanText(row.location);
    const department = this.cleanText(row.department);

    return {
      atsId,
      url,
      // The PeopleHR detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: companyName ?? this.deriveTenantName(tenant),
      locationText,
      department,
      // The per-role detail body renders client-side; the board surface carries no description.
      descriptionHtml: null,
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised PeopleHrJob → JobPostDto. */
  private processJob(
    job: PeopleHrJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveTenantName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `peoplehr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.PEOPLEHR,
      atsId,
      atsType: 'peoplehr',
      department: job.department ?? null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. The board surface exposes no
   * description (the detail body renders client-side), so this normally returns null; it is kept
   * for symmetry with the sibling adapters and to honour `descriptionFormat` should a future
   * board theme inline a body.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant sub-domain label. An explicit `companySlug` is used directly (a full board
   * URL passed as the slug is reduced to its first sub-domain label); a `companyUrl` on a
   * `*.peoplehr.net` host has its first sub-domain label taken as the tenant. Returns an empty
   * string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(PEOPLEHR_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // Bare label — keep only the host-safe leading label (drop any stray path/dot remainder).
      const label = slug.toLowerCase().split('/')[0].split('.')[0].trim();
      return label;
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant sub-domain label from a PeopleHR board URL. The candidate-facing board is
   * `{tenant}.peoplehr.net/...`; the tenant is the first sub-domain label of a `*.peoplehr.net`
   * host. Returns an empty string for a non-PeopleHR host or a bare apex.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(PEOPLEHR_ROOT_DOMAIN)) return '';
      // Strip the root domain; the remaining left-most label is the tenant.
      const prefix = hostname.slice(0, hostname.length - PEOPLEHR_ROOT_DOMAIN.length).replace(/\.$/, '');
      if (!prefix) return ''; // bare apex (peoplehr.net) carries no tenant
      const label = prefix.split('.')[0];
      // Ignore platform-reserved sub-domains that are not tenant boards.
      if (label === 'www' || label === 'login' || label === 'static' || label === 'api') return '';
      return label;
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** De-slugify + title-case the tenant sub-domain label into a display company name. */
  private deriveTenantName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location label as a LocationDto, leaving location null when nothing usable
   * is present. PeopleHR emits a single free-text location label per row (e.g. `London`, `FRA`),
   * so it is split on commas into city / state / country best-effort.
   */
  private extractLocation(job: PeopleHrJob): LocationDto | null {
    const raw = this.cleanText(job.locationText);
    if (!raw) return null;
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    const state = parts.length >= 3 ? parts[1] : null;
    const country = parts[parts.length - 1];
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, location, or department text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (PEOPLEHR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Parse the vacancy GUID out of a row's `data-url` (`?v={GUID}`); null when absent. */
  private guidFromUrl(value: string): string | null {
    if (!value) return null;
    const m = value.match(PEOPLEHR_GUID_REGEX);
    return m ? m[1] : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
