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
  JOBTOOLZ_CAREER_HOST_SUFFIX,
  JOBTOOLZ_ROOT_DOMAIN,
  JOBTOOLZ_LOCALES,
  JOBTOOLZ_DEFAULT_RESULTS,
  JOBTOOLZ_MAX_PAGES,
  JOBTOOLZ_DEFAULT_TIMEOUT_SECONDS,
  JOBTOOLZ_HEADERS,
  JOBTOOLZ_BOARD_REGEX,
  JOBTOOLZ_REMOTE_REGEX,
  jobtoolzCareerOrigin,
} from './jobtoolz.constants';
import { JobtoolzJob, JobtoolzVacancy } from './jobtoolz.types';

/**
 * Jobtoolz ATS careers scraper — generic, multi-tenant.
 *
 * Jobtoolz (jobtoolz.com, Belgium / Benelux) powers each customer's branded, public,
 * unauthenticated candidate-facing jobsite on the shared host
 * `https://{tenant}.jobtoolz.com/`. The open-roles board (`/{locale}`, with `nl` / `en`
 * / `fr` locale variants) is a thin server-rendered shell that embeds the full set of
 * open vacancies directly in the HTML as the first argument of a JavaScript bootstrap
 * call, wired through an Alpine.js attribute on the `<div id="vacatures">` element:
 *
 *   <div id="vacatures" x-data="window.jobComponent([ … vacancy objects … ], 999, … )">
 *
 * Because the array lives inside an HTML attribute, its JSON text is HTML-entity-encoded
 * (`&quot;`, `&amp;`, `&#39;`, …). The adapter extracts that array, HTML-decodes it, and
 * maps each vacancy — rather than depending on a client-rendered DOM or a headless
 * browser. Each vacancy's numeric `id` is the stable ATS id, and its `url` is the
 * canonical candidate-facing detail page (which doubles as the apply URL).
 *
 * The caller addresses a tenant by `companySlug` (e.g. `tordale`) or by `companyUrl` (a
 * jobsite URL whose host encodes the tenant slug). An unknown tenant, one with no open
 * roles, or an empty "geen openstaande vacatures" board degrades naturally to an empty
 * result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an
 * empty / partial result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.JOBTOOLZ,
  name: 'Jobtoolz',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobtoolzService implements IScraper {
  private readonly logger = new Logger(JobtoolzService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Jobtoolz scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Jobtoolz tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Jobtoolz jobsite host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? JOBTOOLZ_DEFAULT_TIMEOUT_SECONDS,
      JOBTOOLZ_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(JOBTOOLZ_HEADERS);

    const resultsWanted = input.resultsWanted ?? JOBTOOLZ_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Jobtoolz jobs for tenant: ${tenant}`);

      const found = await this.fetchVacancies(client, tenant);
      if (!found) {
        this.logger.log(`Jobtoolz tenant "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }

      const { vacancies } = found;
      if (vacancies.length === 0) {
        this.logger.log(`Jobtoolz tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const vacancy of vacancies) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processVacancy(vacancy, tenant, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Jobtoolz role ${vacancy?.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Jobtoolz total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Jobtoolz scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's candidate-facing board across the known locale variants until one
   * returns an embedded vacancy array. Returns the parsed vacancies and the locale that
   * served them, or null when none respond. The vacancies carry absolute `url`s, so the
   * serving locale is informational only.
   */
  private async fetchVacancies(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ vacancies: JobtoolzVacancy[]; locale: string } | null> {
    const origin = jobtoolzCareerOrigin(tenant);
    let attempts = 0;

    for (const locale of JOBTOOLZ_LOCALES) {
      if (attempts >= JOBTOOLZ_MAX_PAGES) return null;
      attempts++;

      const url = locale ? `${origin}/${locale}` : origin;
      const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the tenant
      // host itself is unreachable — no other locale can succeed, so abort the whole
      // probe sweep rather than burning a full timeout per locale.
      if (!hostReachable) return null;
      if (html == null) continue;

      const vacancies = this.extractVacancies(html);
      if (vacancies == null) continue; // no board marker on this page — try next locale

      // A page rendering the board marker is the right surface; return its vacancies
      // (possibly empty — an empty board is a valid "no roles" result).
      return { vacancies, locale };
    }

    return null;
  }

  /**
   * GET a jobsite URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (3xx / 4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the tenant host itself is unreachable and the
   *    caller should stop probing further locales.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: string | null; hostReachable: boolean }> {
    try {
      // Do NOT follow redirects: a real Jobtoolz board serves the locale root as a direct
      // 200, whereas a non-default locale (e.g. `/en` on a Dutch-default tenant)
      // 302-redirects to the tenant's default locale. Surfacing the 3xx as a fast,
      // skippable response avoids re-fetching the same board twice and keeps a dead
      // tenant from burning a timeout.
      const response = await client.get<string>(url, { responseType: 'text', maxRedirects: 0 });
      return {
        data: typeof response.data === 'string' ? response.data : null,
        hostReachable: true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (3xx redirect to default locale, 4xx
        // path-not-found, or 5xx) — it is reachable, so the caller may still try other
        // locales. A 3xx here means "not this locale's board" and is skipped fast.
        this.logger.warn(`Jobtoolz board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Jobtoolz board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Extract the embedded vacancy array from the open-roles board HTML. The board
   * bootstraps with `window.jobComponent([ … ], …)` whose first argument is the vacancy
   * array. Because it lives inside an Alpine.js `x-data` HTML attribute, the array's JSON
   * text is HTML-entity-encoded (`&quot;`, `&amp;`, `&#39;`, …) rather than
   * JS-string-escaped; the adapter HTML-decodes it, then `JSON.parse`s the result.
   * Returns:
   *  - the vacancy array (possibly empty) when the board marker is present + parseable
   *  - `null` when the page carries no board marker (so the caller tries another locale)
   */
  private extractVacancies(html: string): JobtoolzVacancy[] | null {
    JOBTOOLZ_BOARD_REGEX.lastIndex = 0;
    const match = JOBTOOLZ_BOARD_REGEX.exec(html);
    if (!match) return null;

    // The regex match ends at the array's opening `[`; capture the full balanced array.
    const open = match.index + match[0].length - 1;
    const rawArray = this.sliceBalancedArray(html, open);
    if (rawArray == null) return null;

    const jsonText = this.decodeHtmlEntities(rawArray);

    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) return parsed as JobtoolzVacancy[];
      // Some shells may wrap the array; narrow defensively.
      if (parsed && Array.isArray((parsed as { jobs?: unknown }).jobs)) {
        return (parsed as { jobs: JobtoolzVacancy[] }).jobs;
      }
      return [];
    } catch (err: any) {
      this.logger.warn(`Jobtoolz embedded board JSON parse failed: ${err?.message ?? err}`);
      // Marker present but unparseable — treat as an empty board rather than re-probing.
      return [];
    }
  }

  /**
   * Slice the full, balanced `[ … ]` array out of the (still HTML-entity-encoded) board
   * HTML, starting at the opening-bracket index `open`. The vacancy objects contain nested
   * arrays (`filters.filterIds[]`, `filters.types[]`), so a naive non-greedy regex would
   * stop at the first nested `]`. This scan tracks bracket depth while honouring JSON
   * string state — and because the JSON lives inside an HTML attribute, its string
   * delimiters appear as the `&quot;` entity (not a bare `"`), with backslash-escaped
   * quotes inside. Returns the raw array substring (entities intact) or null when the
   * array is unterminated (truncated / malformed HTML).
   */
  private sliceBalancedArray(html: string, open: number): string | null {
    if (html[open] !== '[') return null;
    let depth = 0;
    let inStr = false;
    for (let i = open; i < html.length; i++) {
      // Detect the `&quot;` string delimiter; a backslash before it escapes it (so it is a
      // literal quote inside the string, not a delimiter).
      if (html.startsWith('&quot;', i)) {
        const escaped = inStr && html[i - 1] === '\\';
        if (!escaped) inStr = !inStr;
        i += '&quot;'.length - 1; // skip the rest of the entity
        continue;
      }
      if (inStr) continue;
      const ch = html[i];
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return html.slice(open, i + 1);
      }
    }
    return null; // unterminated — degrade to "no board"
  }

  /**
   * Decode the HTML entities used inside the `x-data` attribute that carries the embedded
   * vacancy array. The attribute value is HTML-attribute-escaped, so the JSON text uses
   * `&quot;` for `"`, `&#39;` / `&apos;` for `'`, `&lt;` / `&gt;` for `<` / `>`, and
   * `&amp;` for `&`. Numeric entities (`&#NN;` / `&#xNN;`) are decoded to their code
   * points. `&amp;` is decoded LAST so an already-decoded `&` is never re-interpreted.
   */
  private decodeHtmlEntities(input: string): string {
    return input
      .replace(/&quot;/g, '"')
      .replace(/&#0?34;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => this.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_m, dec) => this.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, '&');
  }

  /** Safely map a numeric character reference to its character; drops invalid code points. */
  private fromCodePoint(code: number): string {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  }

  /** Map a parsed vacancy → JobPostDto, deduping by ATS id. */
  private processVacancy(
    vacancy: JobtoolzVacancy,
    tenant: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseVacancy(vacancy, tenant);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised JobtoolzJob from a parsed vacancy. */
  private normaliseVacancy(
    vacancy: JobtoolzVacancy,
    tenant: string,
  ): JobtoolzJob | null {
    const atsId = this.deriveAtsId(vacancy);
    if (!atsId) return null;

    const title = this.cleanText(vacancy.title);

    // The vacancy carries its own absolute canonical URL; fall back to the tenant origin
    // only if it is somehow absent. The detail page doubles as the apply surface.
    const url = this.cleanText(vacancy.url) ?? jobtoolzCareerOrigin(tenant);

    const locationText = this.cleanText(vacancy.location);
    const { city, state, country } = this.splitLocation(locationText);
    const employmentType = this.normaliseEmploymentType(vacancy);

    return {
      atsId,
      url,
      applyUrl: url,
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      employmentType,
      department: null,
      datePosted: null,
      isRemote: this.detectRemote(title, locationText, employmentType),
    };
  }

  /** Map a normalised JobtoolzJob → JobPostDto. */
  private processJob(
    job: JobtoolzJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    // The board list carries no rich HTML body; the description stays null and the
    // canonical detail URL is the candidate-facing surface. Format conversion is wired
    // for parity with the sibling adapters and future enrichment.
    const description = this.formatDescription(null, format);

    return new JobPostDto({
      id: `jobtoolz-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.JOBTOOLZ,
      atsId,
      atsType: 'jobtoolz',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Derive the stable ATS id from a vacancy: the numeric `id` (coerced to text). Returns
   * null when absent / empty.
   */
  private deriveAtsId(vacancy: JobtoolzVacancy): string | null {
    return this.numToText(vacancy.id);
  }

  /**
   * Convert an (optional) HTML job-ad body per `descriptionFormat`. The board list
   * carries no body, so this is normally a no-op (null → null); it is kept for parity
   * with the sibling adapters and future detail-page enrichment.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare jobsite
   * URL passed as the slug is reduced to its tenant token); a `companyUrl` on a
   * `jobtoolz.com` host has the tenant taken from its leading sub-domain label. Returns an
   * empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full jobsite URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(JOBTOOLZ_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant token from a Jobtoolz jobsite URL. The candidate-facing host is
   * `{tenant}.jobtoolz.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(JOBTOOLZ_CAREER_HOST_SUFFIX)) {
        // Not a hosted jobsite host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - JOBTOOLZ_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` label.
      if (!label || label === 'www') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: JobtoolzJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state / country.
   * Comma-separated tail is treated as the country; the head as the city. Jobtoolz
   * locations are usually a single municipality (e.g. `Sint-Andries`), so the whole value
   * lands in `city` when there is no comma.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parts = text
      .split(',')
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    const country = parts[parts.length - 1];
    const city = parts.slice(0, parts.length - 1).join(', ');
    return { city: city || null, state: null, country: country || null };
  }

  /**
   * Build a readable employment-type label. Prefers the free-text `types` line (e.g.
   * `Voltijds, Deeltijds`); falls back to the structured `filters.types[]` tokens
   * (e.g. `fulltime`, `parttime`) normalised to a readable, title-cased label.
   */
  private normaliseEmploymentType(vacancy: JobtoolzVacancy): string | null {
    const freeText = this.cleanText(vacancy.types);
    if (freeText) return freeText;

    const tokens = vacancy.filters?.types;
    if (!Array.isArray(tokens) || tokens.length === 0) return null;
    const labels = tokens
      .map((t) => this.cleanText(typeof t === 'string' ? t : null))
      .filter((t): t is string => !!t)
      .map((t) =>
        t
          .replace(/[_]+/g, ' ')
          .replace(/\bfulltime\b/i, 'full time')
          .replace(/\bparttime\b/i, 'part time')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase()),
      );
    return labels.length > 0 ? labels.join(', ') : null;
  }

  /** Detect remote / hybrid roles from the title, location, or employment-type text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    employmentType: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, employmentType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (JOBTOOLZ_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /** Coerce a numeric / string id field into trimmed text, or null when empty. */
  private numToText(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return this.cleanText(typeof value === 'string' ? value : null);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
