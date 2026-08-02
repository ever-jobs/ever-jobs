import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
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
  toDateOnly,
} from '@ever-jobs/common';
import {
  EMPLY_CAREER_HOST_SUFFIX,
  EMPLY_ROOT_DOMAIN,
  EMPLY_INDEX_PATHS,
  EMPLY_LOCALES,
  EMPLY_AD_PATH,
  EMPLY_APPLY_PATH,
  EMPLY_DEFAULT_RESULTS,
  EMPLY_MAX_PAGES,
  EMPLY_DEFAULT_TIMEOUT_SECONDS,
  EMPLY_HEADERS,
  EMPLY_BATCH_REGEX,
  EMPLY_REMOTE_REGEX,
  emplyCareerOrigin,
} from './emply.constants';
import { EmplyJob, EmplyVacancy, EmplyTranslation } from './emply.types';

/**
 * Emply (Visma) ATS careers scraper — generic, multi-tenant.
 *
 * Emply (emply.com, Denmark — part of Visma) powers each customer's branded, public,
 * unauthenticated candidate-facing career site on the shared host
 * `https://{tenant}.career.emply.com/`. The open-roles index page
 * (`/{locale}/vacant-positions`, with `vacancies` / `available-positions` / `jobs`
 * variants) is a thin server-rendered shell that embeds the full set of open
 * vacancies directly in the HTML as a JavaScript bootstrap call:
 *
 *   proceedBatch({ vacancies : JSON.parse('[ … vacancy objects … ]'), … });
 *
 * The adapter extracts that embedded JSON array (undoing the JS `\x27` escaping of the
 * single-quoted string literal) and maps each vacancy — rather than depending on a
 * client-rendered DOM or a headless browser. Each vacancy's `shortId` + `titleAsUrl`
 * build the canonical detail URL `/{locale}/ad/{titleAsUrl}/{shortId}` and apply URL
 * `/{locale}/apply/{titleAsUrl}/{shortId}`; `shortId` is the stable ATS id.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `au`) or by `companyUrl` (a
 * career-site URL whose host encodes the tenant slug). An unknown tenant, one with no
 * open roles, or an empty "We currently have no jobs available" board degrades
 * naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a
 * single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.EMPLY,
  name: 'Emply (Visma)',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class EmplyService implements IScraper {
  private readonly logger = new Logger(EmplyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Emply scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an Emply tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Emply career host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? EMPLY_DEFAULT_TIMEOUT_SECONDS,
      EMPLY_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(EMPLY_HEADERS);

    const resultsWanted = input.resultsWanted ?? EMPLY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Emply jobs for tenant: ${tenant}`);

      const found = await this.fetchVacancies(client, tenant);
      if (!found) {
        this.logger.log(`Emply tenant "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }

      const { vacancies, locale } = found;
      if (vacancies.length === 0) {
        this.logger.log(`Emply tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const vacancy of vacancies) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processVacancy(vacancy, tenant, locale, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Emply role ${vacancy?.shortId ?? vacancy?.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Emply total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Emply scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Probe the tenant's candidate-facing index across the known locale/path variants
   * until one returns an embedded vacancy batch. Returns the parsed vacancies and the
   * locale that served them (used to build per-role URLs), or null when none respond.
   */
  private async fetchVacancies(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ vacancies: EmplyVacancy[]; locale: string } | null> {
    const origin = emplyCareerOrigin(tenant);
    let attempts = 0;

    for (const locale of EMPLY_LOCALES) {
      for (const path of EMPLY_INDEX_PATHS) {
        if (attempts >= EMPLY_MAX_PAGES) return null;
        attempts++;

        const segment = locale ? `${locale}/${path}` : path;
        const url = `${origin}/${segment}`;
        const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
        // A transport-level failure (DNS / refused / reset / timeout) means the
        // tenant host itself is unreachable — no other locale/path can succeed, so
        // abort the whole probe sweep rather than burning a full timeout per combo.
        if (!hostReachable) return null;
        if (html == null) continue;

        const vacancies = this.extractVacancies(html);
        if (vacancies == null) continue; // no batch marker on this page — try next

        // A page rendering the batch marker is the right surface; return its
        // vacancies (possibly empty — an empty board is a valid "no roles" result).
        return { vacancies, locale };
      }
    }

    return null;
  }

  /**
   * GET a career-site URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the
   *    host answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the tenant host itself is unreachable and
   *    the caller should stop probing further locale/path combinations.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: string | null; hostReachable: boolean }> {
    try {
      // Do NOT follow redirects: a real Emply board serves the open-roles index as a
      // direct 200, whereas an unknown / parked tenant 302-redirects OFF the career
      // host to the marketing site (https://emply.com), which can hang. Surfacing the
      // 3xx as a fast, skippable response keeps a dead tenant from burning a timeout.
      const response = await client.get<string>(url, { responseType: 'text', maxRedirects: 0 });
      return {
        data: typeof response.data === 'string' ? response.data : null,
        hostReachable: true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (3xx redirect-away, 4xx path-not-found,
        // or 5xx) — it is reachable, so the caller may still try other locale/path
        // combinations. A 3xx here means "not the board" and is skipped fast.
        this.logger.warn(`Emply board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Emply board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Extract the embedded vacancy array from the open-roles index HTML. The index
   * bootstraps the board with `proceedBatch({ vacancies : JSON.parse('[…]') })`. The
   * argument is a **single-quoted JS string literal** whose runtime value is the JSON
   * text; the literal escapes the characters special to a single-quoted JS string
   * (`\\`, `\'`, `\"`, `\/`, plus the usual `\n` / `\r` / `\t` / `\uXXXX` / `\xXX`).
   * The browser evaluates that literal and then `JSON.parse`s the result, so the
   * adapter mirrors that exactly: decode the JS string literal (without `eval`), then
   * JSON.parse the decoded text. Returns:
   *  - the vacancy array (possibly empty) when the batch marker is present + parseable
   *  - `null` when the page carries no batch marker (so the caller tries another path)
   */
  private extractVacancies(html: string): EmplyVacancy[] | null {
    EMPLY_BATCH_REGEX.lastIndex = 0;
    const match = EMPLY_BATCH_REGEX.exec(html);
    if (!match || !match[1]) return null;

    const jsonText = this.decodeJsStringLiteral(match[1]);

    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) return parsed as EmplyVacancy[];
      // Some shells wrap the array; narrow defensively.
      if (parsed && Array.isArray((parsed as { vacancies?: unknown }).vacancies)) {
        return (parsed as { vacancies: EmplyVacancy[] }).vacancies;
      }
      return [];
    } catch (err: any) {
      this.logger.warn(`Emply embedded batch JSON parse failed: ${err?.message ?? err}`);
      // Marker present but unparseable — treat as an empty board rather than re-probing.
      return [];
    }
  }

  /**
   * Decode the body of a single-quoted JavaScript string literal into its runtime
   * value, scanning left-to-right so each escape is consumed exactly once (this is the
   * disambiguation that a naive global replace gets wrong, e.g. `\\\"`). Recognises the
   * standard JS escapes; `\uXXXX` and `\xXX` are decoded to their code points, and an
   * unrecognised escape drops the backslash (matching JS semantics). No `eval` is used.
   */
  private decodeJsStringLiteral(input: string): string {
    let out = '';
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = input[i + 1];
      if (next === undefined) {
        out += '\\';
        break;
      }
      switch (next) {
        case 'n': out += '\n'; i++; break;
        case 'r': out += '\r'; i++; break;
        case 't': out += '\t'; i++; break;
        case 'b': out += '\b'; i++; break;
        case 'f': out += '\f'; i++; break;
        case 'v': out += '\v'; i++; break;
        case '0': out += '\0'; i++; break;
        case '\\': out += '\\'; i++; break;
        case "'": out += "'"; i++; break;
        case '"': out += '"'; i++; break;
        case '`': out += '`'; i++; break;
        case '/': out += '/'; i++; break;
        case 'u': {
          const hex = input.substr(i + 2, 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 5;
          } else {
            out += 'u';
            i++;
          }
          break;
        }
        case 'x': {
          const hex = input.substr(i + 2, 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 3;
          } else {
            out += 'x';
            i++;
          }
          break;
        }
        default:
          // Unknown escape — JS keeps the following char, drops the backslash.
          out += next;
          i++;
          break;
      }
    }
    return out;
  }

  /** Map a parsed vacancy → JobPostDto, deduping by ATS id. */
  private processVacancy(
    vacancy: EmplyVacancy,
    tenant: string,
    locale: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseVacancy(vacancy, tenant, locale);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised EmplyJob from a parsed vacancy. */
  private normaliseVacancy(
    vacancy: EmplyVacancy,
    tenant: string,
    locale: string,
  ): EmplyJob | null {
    const atsId = this.deriveAtsId(vacancy);
    if (!atsId) return null;

    const titleAsUrl = this.cleanText(vacancy.titleAsUrl);
    const translation = this.pickTranslation(vacancy.translations);
    const title =
      this.cleanText(vacancy.title) ?? this.cleanText(translation?.title);

    const url = this.buildAdUrl(tenant, locale, titleAsUrl, atsId, vacancy);
    const applyUrl = this.buildApplyUrl(tenant, locale, titleAsUrl, atsId, vacancy);

    const locationText = this.cleanText(vacancy.location);
    const { city, state, country } = this.splitLocation(locationText);
    const department = this.cleanText(vacancy.department);

    return {
      atsId,
      url,
      applyUrl,
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(translation?.content),
      department,
      datePosted: this.parseDate(vacancy.published) ?? this.parseDate(vacancy.created),
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised EmplyJob → JobPostDto. */
  private processJob(
    job: EmplyJob,
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
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `emply-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.EMPLY,
      atsId,
      atsType: 'emply',
      department: job.department ?? null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Derive the stable ATS id from a vacancy: prefer the short opaque `shortId`, then
   * the numeric `publishingId`, then the human-facing `number`. Returns null when none
   * is usable.
   */
  private deriveAtsId(vacancy: EmplyVacancy): string | null {
    const shortId = this.cleanText(vacancy.shortId);
    if (shortId) return shortId;
    const publishingId = this.numToText(vacancy.publishingId);
    if (publishingId) return publishingId;
    const number = this.numToText(vacancy.number);
    if (number) return number;
    return null;
  }

  /**
   * Pick the best translation: the first whose HTML `content` body is non-empty,
   * falling back to the first translation with any title, then the first entry.
   */
  private pickTranslation(
    translations: EmplyTranslation[] | null | undefined,
  ): EmplyTranslation | null {
    if (!Array.isArray(translations) || translations.length === 0) return null;
    const withContent = translations.find((t) => this.cleanText(t?.content));
    if (withContent) return withContent;
    const withTitle = translations.find((t) => this.cleanText(t?.title));
    return withTitle ?? translations[0] ?? null;
  }

  /**
   * Convert the HTML job-ad body per `descriptionFormat`. The body is HTML, so HTML
   * returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * career-site URL passed as the slug is reduced to its tenant token); a `companyUrl`
   * on a `career.emply.com` host has the tenant taken from its leading sub-domain
   * label. Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(EMPLY_ROOT_DOMAIN)) {
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
   * Derive the tenant token from an Emply career-site URL. The candidate-facing host
   * is `{tenant}.career.emply.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(EMPLY_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - EMPLY_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` label.
      if (!label || label === 'www') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build the canonical public detail URL for a role, preferring an external ad link. */
  private buildAdUrl(
    tenant: string,
    locale: string,
    titleAsUrl: string | null,
    atsId: string,
    vacancy: EmplyVacancy,
  ): string {
    const external = this.cleanText(vacancy.externalCseAdLink);
    if (external) return external;
    return this.buildPathUrl(tenant, locale, EMPLY_AD_PATH, titleAsUrl, atsId);
  }

  /** Build the canonical public apply URL for a role, preferring an external apply link. */
  private buildApplyUrl(
    tenant: string,
    locale: string,
    titleAsUrl: string | null,
    atsId: string,
    vacancy: EmplyVacancy,
  ): string {
    const external = this.cleanText(vacancy.externalCseApplyLink);
    if (external) return external;
    return this.buildPathUrl(tenant, locale, EMPLY_APPLY_PATH, titleAsUrl, atsId);
  }

  /** Assemble a `{origin}/{locale}/{segment}/{titleAsUrl}/{shortId}` career-site URL. */
  private buildPathUrl(
    tenant: string,
    locale: string,
    segment: string,
    titleAsUrl: string | null,
    atsId: string,
  ): string {
    const origin = emplyCareerOrigin(tenant);
    const localePrefix = locale ? `${locale}/` : '';
    const slug = titleAsUrl ? `${encodeURIComponent(titleAsUrl)}/` : '';
    return `${origin}/${localePrefix}${segment}/${slug}${encodeURIComponent(atsId)}`;
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
  private extractLocation(job: EmplyJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state /
   * country. Comma-separated tail is treated as the country; the head as the city.
   * Emply locations are often a single free-text line (e.g. a street address), so the
   * whole value lands in `city` when there is no comma.
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

  /** Detect remote roles from the title, location, or department text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (EMPLY_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable
   * values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    try {
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // ignore
    }
    return null;
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
