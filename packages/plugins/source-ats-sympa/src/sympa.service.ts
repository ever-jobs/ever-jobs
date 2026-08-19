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
  toDateOnly,
} from '@ever-jobs/common';
import {
  SYMPA_CAREERS_ROOT_DOMAIN,
  SYMPA_OFFERS_PATH,
  SYMPA_PUBLISHED_STATUS,
  SYMPA_DEFAULT_RESULTS,
  SYMPA_MAX_OFFERS,
  SYMPA_DEFAULT_TIMEOUT_SECONDS,
  SYMPA_HEADERS,
  SYMPA_REMOTE_REGEX,
  sympaOffersUrl,
  sympaOfferDetailUrl,
} from './sympa.constants';
import { SympaOffer, SympaOffersResponse, SympaJob } from './sympa.types';

/**
 * Sympa ATS careers scraper — generic, multi-tenant.
 *
 * Sympa (sympa.com — a Nordic, Finland-origin HR suite with a built-in recruitment module)
 * publishes each customer's branded, public, unauthenticated candidate-facing careers board on
 * a per-tenant host `https://{slug}.recruitee.com/`. The board is a client-rendered site
 * backed by a **single public, anonymous JSON offers feed** it consumes (no bearer token, no API
 * key — the feed responds 200 to any anonymous visitor):
 *
 *   GET https://{slug}.recruitee.com/api/offers/
 *     → { "offers": [ { id, slug, title, status, careers_url, careers_apply_url,
 *                       city, country, country_code, location, department,
 *                       employment_type_code, remote, hybrid, on_site,
 *                       created_at, published_at, description, requirements,
 *                       company_name, mailbox_email, … } ] }
 *
 * The feed returns the tenant's full open-role set in a single envelope (it is not query-cursor
 * paginated — the board renders the whole `offers` array client-side), so the adapter resolves
 * the tenant slug, GETs the feed once, keeps only `published` roles, and maps each — rather than
 * depending on a client-rendered DOM, a headless browser, or any authenticated Sympa API. Each
 * role's numeric `id` is the stable ATS id, and its `careers_url` is the canonical public
 * `/o/{slug}` detail page (with `careers_apply_url` the apply page).
 *
 * The caller addresses a tenant by `companySlug` (the careers slug, e.g. `sympa`) or by
 * `companyUrl` (a `{slug}.recruitee.com` URL). An unknown tenant (the host answers HTTP 404),
 * an empty board, or a malformed body degrades naturally to an empty / partial result. A fetch
 * error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial result
 * rather than throwing, so a single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SYMPA,
  name: 'Sympa',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SympaService implements IScraper {
  private readonly logger = new Logger(SympaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Sympa scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a Sympa tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Sympa host degrades gracefully fast rather
    // than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys off
    // `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter timeout; we
    // only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SYMPA_DEFAULT_TIMEOUT_SECONDS,
      SYMPA_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SYMPA_HEADERS);

    const resultsWanted = input.resultsWanted ?? SYMPA_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Sympa offers for slug: ${slug}`);

      // The offers feed returns the tenant's full open-role set in one envelope (no query
      // pagination), so a single GET is sufficient. A transport failure / HTTP error / malformed
      // body all yield null → empty result.
      const body = await this.fetchOffers(client, slug);
      if (!body) {
        return new JobResponseDto([]);
      }

      const offers = Array.isArray(body.offers) ? body.offers : [];
      if (offers.length === 0) {
        this.logger.log(`Sympa board for ${slug} has no offers`);
        return new JobResponseDto([]);
      }

      const companyName = this.cleanText(offers[0]?.company_name) ?? this.deriveSlugName(slug);
      const seen = new Set<string>();

      // Bound the in-memory work by the offer cap, then by `resultsWanted` (after the
      // published-only filter and dedup).
      const bounded = offers.slice(0, SYMPA_MAX_OFFERS);
      for (const offer of bounded) {
        if (jobPosts.length >= resultsWanted) break;
        // Skip non-live roles (draft / closed / archived); only `published` roles are
        // candidate-facing.
        if (!this.isPublished(offer)) continue;
        try {
          const post = this.processItem(offer, slug, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Sympa role ${offer?.id}: ${err.message}`);
        }
      }

      this.logger.log(`Sympa total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Sympa scrape error for ${slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET the tenant's public offers feed as JSON. Returns the parsed `{ offers: [...] }`
   * envelope, or null when the response carried no usable JSON, the host answered an HTTP error
   * status (4xx / 5xx — e.g. an unknown tenant 404), or a transport-level failure occurred
   * (DNS / connection refused / reset / timeout). Never throws — every failure degrades to no
   * roles.
   */
  private async fetchOffers(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<SympaOffersResponse | null> {
    const url = sympaOffersUrl(slug);
    try {
      const response = await client.get<SympaOffersResponse | string>(url);
      return this.coerceOffers(response.data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // to ingest (e.g. an unknown / disabled tenant returns 404).
        this.logger.warn(`Sympa offers feed returned HTTP ${status} for ${slug}`);
      } else {
        // No HTTP response → transport-level failure (DNS / refused / reset / timeout).
        this.logger.warn(`Sympa offers feed fetch failed for ${slug}: ${err?.message ?? err}`);
      }
      return null;
    }
  }

  /**
   * Coerce an axios response body into a parsed offers envelope. The client usually parses the
   * JSON for us (object body); a text/plain string body is parsed defensively. A non-object /
   * unparseable body yields null (degrade to no roles).
   */
  private coerceOffers(data: SympaOffersResponse | string | unknown): SympaOffersResponse | null {
    if (data && typeof data === 'object') return data as SympaOffersResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as SympaOffersResponse;
      } catch (err: any) {
        this.logger.warn(`Sympa JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** True when an offer is live / candidate-facing (`status === 'published'`). */
  private isPublished(offer: SympaOffer): boolean {
    const status = this.cleanText(offer?.status);
    // Be lenient: a future shape that omits `status` is treated as live rather than dropped.
    if (!status) return true;
    return status.toLowerCase() === SYMPA_PUBLISHED_STATUS;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    offer: SympaOffer,
    slug: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(offer, slug, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, slug, format);
  }

  /** Build a normalised SympaJob from a parsed role. */
  private normaliseItem(offer: SympaOffer, slug: string, companyName: string): SympaJob | null {
    const atsId = this.cleanText(this.toStringId(offer.id));
    if (!atsId) return null;

    const offerSlug = this.cleanText(offer.slug);
    // The feed always carries the canonical detail URL in `careers_url`; fall back to a derived
    // `/o/{slug}` only if a future shape ever omits it.
    const url =
      this.cleanText(offer.careers_url) ??
      (offerSlug ? sympaOfferDetailUrl(slug, offerSlug) : null);
    if (!url) return null;

    const applyUrl = this.cleanText(offer.careers_apply_url) ?? url;

    const nested = Array.isArray(offer.locations) ? offer.locations[0] : null;
    const city = this.cleanText(offer.city) ?? this.cleanText(nested?.city ?? nested?.name);
    const state = this.cleanText(offer.state_name) ?? this.cleanText(nested?.state);
    const country = this.cleanText(offer.country) ?? this.cleanText(nested?.country);
    const locationText =
      this.cleanText(offer.location) ?? this.joinLocation(city, state, country);

    const department = this.cleanText(offer.department) ?? this.cleanText(offer.category_code);
    const title = this.cleanText(offer.title);
    const employmentType = this.cleanText(offer.employment_type_code);

    return {
      atsId,
      url,
      applyUrl,
      title,
      companyName: this.cleanText(offer.company_name) ?? companyName ?? this.deriveSlugName(slug),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.combineBody(offer.description, offer.requirements),
      mailboxEmail: this.cleanText(offer.mailbox_email),
      department,
      employmentType,
      datePosted: this.parseDate(offer.published_at) ?? this.parseDate(offer.created_at),
      isRemote: this.detectRemote(offer, title, locationText, department),
    };
  }

  /** Map a normalised SympaJob → JobPostDto. */
  private processJob(job: SympaJob, slug: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(slug);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    // Harvest contact emails from the description body, plus the role's own inbound mailbox
    // address when present (de-duplicated).
    const emails = this.collectEmails(description, job.mailboxEmail);

    return new JobPostDto({
      id: `sympa-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails,
      site: Site.SYMPA,
      atsId,
      atsType: 'sympa',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Combine the role's `description` and `requirements` HTML bodies into one document. Tenants
   * sometimes split the role body across the two fields; concatenating keeps the full text.
   */
  private combineBody(
    description: string | null | undefined,
    requirements: string | null | undefined,
  ): string | null {
    const desc = this.cleanText(description);
    const reqs = this.cleanText(requirements);
    if (desc && reqs) {
      // Avoid double-counting when the description already embeds the requirements block.
      if (desc.includes(reqs)) return desc;
      return `${desc}\n${reqs}`;
    }
    return desc ?? reqs;
  }

  /**
   * Convert the role description body per `descriptionFormat`. Sympa exposes the body as HTML,
   * so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /** Harvest emails from the description, plus the role's mailbox address, de-duplicated. */
  private collectEmails(
    description: string | null,
    mailboxEmail: string | null | undefined,
  ): string[] | null {
    const fromBody = extractEmails(description ?? '') ?? [];
    const mailbox = this.cleanText(mailboxEmail);
    const set = new Set<string>(fromBody);
    if (mailbox) set.add(mailbox);
    return set.size > 0 ? Array.from(set) : null;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare board URL passed
   * as the slug is reduced to its `{slug}.recruitee.com` sub-domain token); a `companyUrl` on
   * a `*.recruitee.com` host has the slug taken from its left-most sub-domain label. Returns
   * an empty string when neither yields a slug.
   */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SYMPA_CAREERS_ROOT_DOMAIN)) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant slug from a Sympa board URL. The candidate-facing board is
   * `{slug}.recruitee.com`; the slug is the left-most sub-domain label on the careers root
   * domain. A bare careers root domain (`www.` / apex) carries no tenant slug.
   */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      const suffix = `.${SYMPA_CAREERS_ROOT_DOMAIN}`;
      if (!hostname.endsWith(suffix)) return '';
      const label = hostname.slice(0, hostname.length - suffix.length);
      // The left-most label is the tenant slug; reject empties and the apex `www`.
      if (!label || label === 'www') return '';
      // Guard against a deeper sub-domain (`a.b.recruitee.com`) — take the first label.
      const first = label.split('.')[0];
      return first || '';
    } catch {
      // Malformed URL — no slug.
    }
    return '';
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(slug: string): string {
    const base = slug && slug.trim() ? slug.trim() : slug;
    return base
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: SympaJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Join the structured location parts into a single free-text line (for remote tests). */
  private joinLocation(
    city: string | null,
    state: string | null,
    country: string | null,
  ): string | null {
    const parts = [city, state, country].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * Detect remote roles from the structured `remote` / `hybrid` work-model flags first, then
   * from the title, location, or department text.
   */
  private detectRemote(
    offer: SympaOffer,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    if (offer.remote === true || offer.hybrid === true) return true;
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SYMPA_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a date value into a YYYY-MM-DD string. The feed emits `YYYY-MM-DD HH:MM:SS UTC`;
   * normalise the space-separated form to an ISO-parseable one. Non-absolute / unparseable
   * values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    // Normalise `YYYY-MM-DD HH:MM:SS UTC` → `YYYY-MM-DDTHH:MM:SSZ` for reliable parsing.
    const iso = cleaned
      .replace(/\s+UTC$/i, 'Z')
      .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2');
    try {
      const parsed = new Date(iso);
      if (!isNaN(parsed.getTime())) return toDateOnly(iso);
    } catch {
      // ignore
    }
    return null;
  }

  /** Coerce a numeric-or-string id into a string, else null. */
  private toStringId(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') return value;
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
