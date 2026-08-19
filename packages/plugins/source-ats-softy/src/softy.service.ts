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
  SOFTY_ROOT_DOMAIN,
  SOFTY_SCHEME,
  SOFTY_OFFERS_PATH,
  SOFTY_OFFER_PATH,
  SOFTY_DEFAULT_RESULTS,
  SOFTY_MAX_DETAIL_FETCHES,
  SOFTY_HEADERS,
  SOFTY_OFFER_LINK_REGEX,
  SOFTY_PUBLISHED_REGEX,
  SOFTY_CONTRACT_REGEX,
  SOFTY_REMOTE_REGEX,
} from './softy.constants';
import { SoftyCardJob, SoftyJob } from './softy.types';

/**
 * Softy (softy.pro) ATS careers scraper — generic, multi-tenant.
 *
 * Softy (softy.pro, Dijon, France) powers each customer tenant's branded, public,
 * unauthenticated candidate-facing careers board on its own sub-domain of the shared
 * application host, keyed by the tenant slug:
 *
 *   GET https://{tenant}.softy.pro/offres
 *
 * That index is server-rendered HTML (not a SPA), so the adapter enumerates the open
 * roles directly from it: each role renders as a card whose anchor is the canonical
 * detail / apply URL `https://{tenant}.softy.pro/offre/{ID}-{title-slug}`, alongside
 * labelled card text (title heading, location city, contract type, and a
 * "Mise en ligne le DD/MM/YYYY" published-date line). The numeric `{ID}` segment is
 * the stable Softy ATS id. The per-role detail page is fetched best-effort for a
 * richer description body (it carries no JSON-LD / og: metadata).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `groupecls`) or by `companyUrl` (a board URL on a `softy.pro` host whose leading
 * sub-domain label is the tenant). An unknown tenant resolves to a host that answers
 * an HTTP 4xx / empty board, so it degrades naturally to an empty result. A fetch
 * error, an HTTP 4xx, a DNS failure, or a malformed body degrades to an empty /
 * partial result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SOFTY,
  name: 'Softy',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SoftyService implements IScraper {
  private readonly logger = new Logger(SoftyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Softy scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Softy tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SOFTY_HEADERS);

    const resultsWanted = input.resultsWanted ?? SOFTY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Softy jobs for tenant: ${tenant}`);

      const cards = await this.fetchCards(client, tenant, resultsWanted);
      if (cards.length === 0) {
        this.logger.log(`Softy tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Per-role detail fan-out (bounded) for the richer description body. Use
      // allSettled so a single failed detail fetch never nukes the batch.
      const detailCap = Math.min(cards.length, SOFTY_MAX_DETAIL_FETCHES);
      const settled = await Promise.allSettled(
        cards.slice(0, detailCap).map((card) => this.fetchDetailBody(client, card, tenant)),
      );
      const bodies = new Map<string, string | null>();
      settled.forEach((result, i) => {
        const id = cards[i].id;
        bodies.set(id, result.status === 'fulfilled' ? result.value : null);
      });

      for (const card of cards) {
        try {
          const post = this.processCard(
            card,
            tenant,
            bodies.get(card.id) ?? null,
            input.descriptionFormat,
          );
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Softy role ${card.id}: ${err.message}`);
        }
      }

      this.logger.log(`Softy total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Softy scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch + parse the tenant's index HTML, accumulating up to `resultsWanted` deduped
   * roles. The index renders the full board in one server-rendered document; an
   * unknown tenant or an HTTP 4xx / missing body degrades to an empty list.
   */
  private async fetchCards(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
  ): Promise<SoftyCardJob[]> {
    const url = `${SOFTY_SCHEME}${tenant}.${SOFTY_ROOT_DOMAIN}${SOFTY_OFFERS_PATH}`;
    const html = await this.fetchHtml(client, url, tenant);
    if (html == null) return [];

    const parsed = this.parseIndex(html, tenant);
    const seen = new Set<string>();
    const cards: SoftyCardJob[] = [];
    for (const card of parsed) {
      const id = this.cleanText(card.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      cards.push(card);
      if (cards.length >= resultsWanted) break;
    }
    return cards;
  }

  /** GET a board URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Softy board not found (HTTP ${status}) for ${tenant}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`Softy board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered index HTML into role fragments. Rather than depend on
   * volatile CSS class names, we anchor on the canonical detail links
   * (`/offre/{ID}-{title-slug}`) and read the labelled card text immediately around
   * each link (location, contract type, "Mise en ligne le …").
   */
  private parseIndex(html: string, tenant: string): SoftyCardJob[] {
    const out: SoftyCardJob[] = [];
    const byId = new Map<string, SoftyCardJob>();

    SOFTY_OFFER_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SOFTY_OFFER_LINK_REGEX.exec(html)) !== null) {
      const [, id, slug] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const cleanSlug = this.deslugTitleSlug(slug);
      const url = `${SOFTY_SCHEME}${tenant}.${SOFTY_ROOT_DOMAIN}${SOFTY_OFFER_PATH}${jobId}-${this.cleanText(slug) ?? ''}`;

      const windowText = this.cardWindow(html, match.index);

      const card: SoftyCardJob = {
        id: jobId,
        slug: cleanSlug,
        url,
        title: this.titleFromSlug(slug),
        location: this.locationFromWindow(windowText),
        contractType: this.contractFromWindow(windowText),
        publishedAt: this.publishedFromWindow(windowText),
      };

      byId.set(jobId, card);
      out.push(card);
    }

    return out;
  }

  /**
   * Extract a window of plain text around a detail link, used to recover the card's
   * labelled fields. The card renders its fields close to its anchor, so a bounded
   * slice on either side captures them without bleeding into siblings.
   */
  private cardWindow(html: string, index: number): string {
    const start = Math.max(0, index - 200);
    const end = Math.min(html.length, index + 900);
    return htmlToPlainText(html.slice(start, end)) ?? '';
  }

  /** Read the "Mise en ligne le DD/MM/YYYY" date out of a card window, if present. */
  private publishedFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    const m = SOFTY_PUBLISHED_REGEX.exec(windowText);
    return m ? m[0] : null;
  }

  /** Read the contract-type token (CDI / CDD / Apprentissage / Stage …) from a window. */
  private contractFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    const m = SOFTY_CONTRACT_REGEX.exec(windowText);
    return m ? this.cleanText(m[0]) : null;
  }

  /**
   * Best-effort recovery of the location city from a card window. The contract token
   * and the "Mise en ligne" line are stripped; the remaining short text token nearest
   * the anchor is treated as the location. Returns null when nothing usable remains.
   */
  private locationFromWindow(windowText: string): string | null {
    if (!windowText) return null;
    let text = windowText
      .replace(SOFTY_PUBLISHED_REGEX, ' ')
      .replace(/\bMise\s+en\s+ligne\b/gi, ' ')
      .replace(SOFTY_CONTRACT_REGEX, ' ');
    // Collapse whitespace and drop obvious UI chrome tokens.
    text = text
      .replace(/\b(Postuler|Voir l'offre|Partager|Retour|Offres|Accueil)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!text) return null;
    // A French city is typically a short capitalised token (optionally hyphenated /
    // accented). Pick the first such token-run, bounded to keep it from grabbing a
    // whole sentence.
    const m =
      /([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+(?:[\s-][A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+){0,3})/.exec(
        text,
      );
    const candidate = m ? this.cleanText(m[1]) : null;
    if (!candidate) return null;
    // Guard against accidentally capturing the title; keep short location-like tokens.
    return candidate.length <= 60 ? candidate : null;
  }

  /**
   * Best-effort fetch of the per-role detail page body. The detail page is server-
   * rendered HTML but carries no JSON-LD / og: metadata, so we recover the visible
   * body text. An HTTP 4xx / network error degrades to null rather than throwing.
   */
  private async fetchDetailBody(
    client: ReturnType<typeof createHttpClient>,
    card: SoftyCardJob,
    tenant: string,
  ): Promise<string | null> {
    const url = this.cleanText(card.url);
    if (!url) return null;
    const html = await this.fetchHtml(client, url, tenant);
    if (html == null) return null;
    const text = htmlToPlainText(html);
    const cleaned = this.cleanText(text);
    if (!cleaned) return null;
    // The detail page body is the listing-level description text. Keep it bounded so a
    // page's surrounding chrome does not balloon the stored description.
    return cleaned.length > 8000 ? cleaned.slice(0, 8000) : cleaned;
  }

  /** Map a parsed index card → JobPostDto. */
  private processCard(
    card: SoftyCardJob,
    tenant: string,
    detailBody: string | null,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseJob(card, tenant, detailBody);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised SoftyJob from a parsed index card. */
  private normaliseJob(card: SoftyCardJob, tenant: string, detailBody: string | null): SoftyJob {
    const jobId = this.cleanText(card.id) ?? '';
    const title = this.cleanText(card.title);
    const locationText = this.cleanText(card.location);
    const { city, state, country } = this.splitLocation(locationText);

    return {
      jobId,
      url: this.cleanText(card.url) ?? this.buildJobUrl(tenant, card),
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      employmentType: this.normaliseEmploymentType(card.contractType),
      datePosted: this.parseDate(card.publishedAt),
      isRemote: this.detectRemote(title, locationText, card.contractType),
      description: detailBody,
    };
  }

  /** Map a normalised SoftyJob → JobPostDto. */
  private processJob(
    job: SoftyJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    // Prefer the detail-page body as the description; fall back to the location line.
    const source = job.description ?? job.locationText ?? null;
    const description = this.formatDescription(source, format);

    return new JobPostDto({
      id: `softy-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SOFTY,
      atsId,
      atsType: 'softy',
      department: null,
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the listing-level descriptive text per `descriptionFormat`. The recovered
   * body is already plain text, so HTML / markdown / plain all return it (markdown
   * passes it through the converter; plain strips any residual markup).
   */
  private formatDescription(text: string | null, format?: DescriptionFormat): string | null {
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare board
   * URL passed as the slug is reduced to its tenant sub-domain label); a `companyUrl`
   * on a `softy.pro` host has the tenant taken from its leading sub-domain label.
   * Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL / host as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SOFTY_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Softy URL. The candidate-facing forms are
   * `https://{tenant}.softy.pro/offres` and
   * `https://{tenant}.softy.pro/offre/{ID}-{slug}`; the tenant is the leading
   * sub-domain label of a `softy.pro` host.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(`.${SOFTY_ROOT_DOMAIN}`) && hostname !== SOFTY_ROOT_DOMAIN) {
        return '';
      }
      const label = hostname.slice(0, hostname.length - SOFTY_ROOT_DOMAIN.length).replace(/\.$/, '');
      // Strip a single leading sub-domain label; ignore the bare apex / `www`.
      const firstLabel = label.split('.').filter((s) => s.length > 0)[0];
      if (!firstLabel || firstLabel === 'www') return '';
      return firstLabel.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build the canonical public detail / apply URL for a role from its parts. */
  private buildJobUrl(tenant: string, card: SoftyCardJob): string {
    const id = this.cleanText(card.id) ?? '';
    const slug = this.cleanText(card.slug) ?? '';
    return `${SOFTY_SCHEME}${tenant}.${SOFTY_ROOT_DOMAIN}${SOFTY_OFFER_PATH}${id}-${slug}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a URL title slug (e.g. `manager-it-workplace-h-f`) into a readable title. */
  private titleFromSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    if (!cleaned) return null;
    return cleaned
      .replace(/[-_]+/g, ' ')
      .replace(/\bh\s*f\b/gi, 'H/F')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Normalise a raw title slug for storage (lower-case, dash-separated). */
  private deslugTitleSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    return cleaned ? cleaned.toLowerCase() : null;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. Softy renders a single free-text location city
   * (e.g. "Toulouse"); we keep it as the city, best-effort.
   */
  private extractLocation(job: SoftyJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state /
   * country. Comma-separated tail is treated as the country; the head as the city.
   * Softy tenants are French, so a bare city line yields just the city.
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

  /** Detect remote / télétravail roles from the title, location, or contract text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    contractType: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, contractType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SOFTY_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote"/"Télétravail" marker, not a place. */
  private isRemoteToken(value: string): boolean {
    return /^(remote|t[ée]l[ée]travail|distanciel)$/i.test(value.trim());
  }

  /**
   * Normalise a Softy contract-type token (e.g. "CDI", "Apprentissage - 24 Mois",
   * "Stage - 4 Mois") into a readable, trimmed label. Known short codes are kept
   * upper-case; longer labels are title-cased.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const upper = cleaned.toUpperCase();
    if (upper === 'CDI' || upper === 'CDD') return upper;
    const spaced = cleaned.replace(/\s{2,}/g, ' ').trim();
    return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a "Mise en ligne le DD/MM/YYYY" value into a YYYY-MM-DD string. The Softy
   * date is day-first (French locale); a value that does not match yields null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = SOFTY_PUBLISHED_REGEX.exec(cleaned);
    if (!m) return null;
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3];
    const monthNum = Number(month);
    const dayNum = Number(day);
    if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
    return `${year}-${month}-${day}`;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
