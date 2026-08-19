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
  SUBSCRIBEHR_ROOT_DOMAIN,
  SUBSCRIBEHR_BOARD_HOST_SUFFIX,
  SUBSCRIBEHR_DEFAULT_RESULTS,
  SUBSCRIBEHR_MAX_PAGES,
  SUBSCRIBEHR_DEFAULT_TIMEOUT_SECONDS,
  SUBSCRIBEHR_HEADERS,
  SUBSCRIBEHR_VACANCY_ID_REGEX,
  SUBSCRIBEHR_JOB_NAME_REGEX,
  SUBSCRIBEHR_JOB_SHORT_DESC_REGEX,
  SUBSCRIBEHR_JOB_URL_REGEX,
  SUBSCRIBEHR_JOB_PATH_REGEX,
  SUBSCRIBEHR_LI_REGEX,
  SUBSCRIBEHR_JOB_DESC_BLOCK_REGEX,
  SUBSCRIBEHR_REMOTE_REGEX,
  SUBSCRIBEHR_EMPLOYMENT_TYPE_REGEX,
  subscribeHrListingUrl,
  subscribeHrJobUrl,
} from './subscribehr.constants';
import { SubscribeHrCard, SubscribeHrJob } from './subscribehr.types';

/**
 * Subscribe-HR ATS careers scraper — generic, multi-tenant.
 *
 * Subscribe-HR (subscribe-hr.com.au — an Australian cloud HR & e-recruitment platform serving
 * employers across Australia & New Zealand) powers each customer's branded, public,
 * unauthenticated candidate-facing careers board on the shared platform host
 * `https://{tenant}.careers.subscribe-hr.com/`, addressed by a per-tenant **partner key** (the
 * first sub-domain label, e.g. `subscribehr16`). Unlike a JSON-feed ATS, the board is
 * **server-rendered HTML** — there is no separate anonymous JSON/RSS endpoint, but the listing
 * page carries every open role inline as a self-contained card, so the adapter never needs a
 * per-role detail fetch:
 *
 *   - The role's stable numeric vacancy id rides the apply control
 *     (`<a … data-vacancyId="{id}" class="button apply">`).
 *   - Hidden inputs carry clean fields: `jobName` (title), `jobShortDescription` (summary), and
 *     `jobUrl` (the canonical `/jobs/{id}-{slug}` detail URL).
 *   - A `<ul>` carries free-text attribute bullets (first bullet = location town; the rest are
 *     requirement / employment-type / salary bullets), and `<div class="job-desc">` carries a
 *     short HTML summary.
 *
 * The board paginates with a bare `?page={n}` control, so the adapter walks pages until one
 * yields no new vacancy ids, bounded by a page cap and by `resultsWanted`, and maps each card —
 * rather than depending on a client-rendered DOM, a headless browser, or any authenticated
 * Subscribe-HR API. Each card's `data-vacancyId` is the stable ATS id, and its `jobUrl` is the
 * canonical public `/jobs/{id}-{slug}` detail / apply page.
 *
 * The caller addresses a tenant by `companySlug` (the partner key, e.g. `subscribehr16`) or by
 * `companyUrl` (a `*.careers.subscribe-hr.com` URL whose first sub-domain label is the tenant).
 * An unknown tenant or an empty board degrades naturally to an empty result. A fetch error, an
 * HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single bad tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SUBSCRIBEHR,
  name: 'Subscribe-HR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SubscribeHrService implements IScraper {
  private readonly logger = new Logger(SubscribeHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Subscribe-HR scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Subscribe-HR tenant from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Subscribe-HR host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SUBSCRIBEHR_DEFAULT_TIMEOUT_SECONDS,
      SUBSCRIBEHR_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SUBSCRIBEHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? SUBSCRIBEHR_DEFAULT_RESULTS;
    const companyName = this.deriveTenantName(tenant);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Subscribe-HR careers board for tenant: ${tenant}`);

      // Drain the paginated server-rendered listing. The board has no pagination meta, so we
      // stop when a page yields no NEW vacancy ids (past the last page, or a page that simply
      // repeats earlier roles), when we hit the page cap, or once `resultsWanted` roles are
      // collected. A transport-level failure (host unreachable) aborts the sweep; an HTTP error
      // / malformed page degrades to an empty / partial result.
      for (let page = 1; page <= SUBSCRIBEHR_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, tenant, page);
        if (!result.hostReachable) break;
        const html = result.html;
        if (!html) break; // HTTP error / empty body → stop draining

        const cards = this.parseCards(html, tenant);
        if (cards.length === 0) break; // no role cards on this page → past the last page

        let newOnPage = 0;
        for (const card of cards) {
          if (jobPosts.length >= resultsWanted) break;
          const atsId = this.cleanText(card.vacancyId);
          if (!atsId || seen.has(atsId)) continue;
          seen.add(atsId);
          newOnPage++;
          try {
            const post = this.processCard(card, tenant, companyName, input.descriptionFormat);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Subscribe-HR role ${atsId}: ${err.message}`);
          }
        }

        // A page that repeated only already-seen roles means the pager has wrapped / stalled.
        if (newOnPage === 0) break;
      }

      this.logger.log(`Subscribe-HR total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Subscribe-HR scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET one listing page of the public careers board as HTML. Returns `{ html, hostReachable }`:
   *  - `html` is the page body, or null when the response carried no usable body / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable and the caller should stop
   *    draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    page: number,
  ): Promise<{ html: string | null; hostReachable: boolean }> {
    const url = subscribeHrListingUrl(tenant, page);
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return { html: html || null, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // more to drain.
        this.logger.warn(`Subscribe-HR board returned HTTP ${status} for ${tenant} page ${page}`);
        return { html: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host
      // is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(
        `Subscribe-HR board fetch failed for ${tenant} page ${page}: ${err?.message ?? err}`,
      );
      return { html: null, hostReachable: false };
    }
  }

  /**
   * Parse the role cards out of a listing page. The board anchors each card on the apply
   * control's `data-vacancyId`; we walk those ids and, for each, slice a bounded window of the
   * surrounding markup to read that card's hidden inputs, attribute bullets, and summary block.
   */
  private parseCards(html: string, tenant: string): SubscribeHrCard[] {
    const cards: SubscribeHrCard[] = [];
    const idRegex = new RegExp(SUBSCRIBEHR_VACANCY_ID_REGEX.source, 'gi');
    let match: RegExpExecArray | null;

    while ((match = idRegex.exec(html)) !== null) {
      const vacancyId = match[1];
      // The card's fields sit AROUND the apply control: the hidden inputs and the title follow
      // it, while the `<ul>` of bullets and the `job-desc` summary may precede or follow. Slice
      // a generous window centred on the control so the per-card regexes stay local to this
      // role and never bleed into the next card.
      const start = Math.max(0, match.index - 400);
      const end = Math.min(html.length, match.index + 2400);
      const window = html.slice(start, end);

      const card = this.parseCardWindow(window, vacancyId, tenant);
      if (card) cards.push(card);
    }

    return cards;
  }

  /** Extract a single card's fields from a bounded markup window. */
  private parseCardWindow(
    window: string,
    vacancyId: string,
    tenant: string,
  ): SubscribeHrCard | null {
    const jobName = this.firstGroup(window, SUBSCRIBEHR_JOB_NAME_REGEX);
    const jobShortDescription = this.firstGroup(window, SUBSCRIBEHR_JOB_SHORT_DESC_REGEX);
    let jobUrl = this.firstGroup(window, SUBSCRIBEHR_JOB_URL_REGEX);

    // Fall back to a `/jobs/{id}-{slug}` path scraped from the window, then to a fully derived
    // URL, when the hidden `jobUrl` input is absent for this card.
    if (!jobUrl) {
      const pathMatch = SUBSCRIBEHR_JOB_PATH_REGEX.exec(window);
      if (pathMatch && pathMatch[1] === vacancyId) {
        jobUrl = subscribeHrJobUrl(tenant, vacancyId, pathMatch[2]);
      }
    }

    const attributes = this.parseAttributes(window);
    const descriptionHtml = this.parseDescriptionBlock(window);

    return {
      vacancyId,
      jobName: jobName ? this.decodeEntities(jobName) : null,
      jobShortDescription: jobShortDescription ? this.decodeEntities(jobShortDescription) : null,
      jobUrl: jobUrl ? this.decodeEntities(jobUrl) : null,
      attributes,
      descriptionHtml,
    };
  }

  /** Pull the free-text `<li>` attribute bullets out of a card window, cleaned and deduped. */
  private parseAttributes(window: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const liRegex = new RegExp(SUBSCRIBEHR_LI_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = liRegex.exec(window)) !== null) {
      const text = this.cleanText(this.decodeEntities(htmlToPlainText(match[1]) ?? match[1]));
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }

  /** Pull the short HTML summary block (`<div class="job-desc">`) out of a card window. */
  private parseDescriptionBlock(window: string): string | null {
    const block = this.firstGroup(window, SUBSCRIBEHR_JOB_DESC_BLOCK_REGEX);
    if (!block) return null;
    // The block holds a short HTML summary plus a trailing "Find out more" anchor; keep the raw
    // HTML so format conversion is consistent downstream.
    const trimmed = block.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Map a parsed card → JobPostDto. */
  private processCard(
    card: SubscribeHrCard,
    tenant: string,
    companyName: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseCard(card, tenant, companyName);
    if (!job) return null;
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised SubscribeHrJob from a parsed card. */
  private normaliseCard(
    card: SubscribeHrCard,
    tenant: string,
    companyName: string,
  ): SubscribeHrJob | null {
    const atsId = this.cleanText(card.vacancyId);
    if (!atsId) return null;

    const url = this.cleanText(card.jobUrl);
    if (!url) return null;

    const attributes = Array.isArray(card.attributes) ? card.attributes : [];
    // The first attribute bullet is the role's location town on every board observed.
    const city = attributes.length > 0 ? this.cleanText(attributes[0]) : null;
    const employmentType = this.detectEmploymentType(attributes);
    const title = this.cleanText(card.jobName);
    const summaryText = this.cleanText(card.jobShortDescription);
    const locationText = city;

    return {
      atsId,
      url,
      // The detail page hosts the apply control inline; the canonical apply URL is the detail URL.
      applyUrl: url,
      title,
      companyName,
      city,
      // Subscribe-HR boards carry only a location town bullet, not a structured state / country;
      // Subscribe-HR's tenant base is Australia & New Zealand, so country defaults are left to
      // the consumer rather than guessed here.
      state: null,
      country: null,
      locationText,
      descriptionHtml: this.cleanText(card.descriptionHtml),
      descriptionText: summaryText,
      department: null,
      employmentType,
      datePosted: null,
      isRemote: this.detectRemote(title, locationText, summaryText, attributes),
    };
  }

  /** Map a normalised SubscribeHrJob → JobPostDto. */
  private processJob(
    job: SubscribeHrJob,
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
    const description = this.formatDescription(
      job.descriptionHtml ?? null,
      job.descriptionText ?? null,
      format,
    );

    return new JobPostDto({
      id: `subscribehr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SUBSCRIBEHR,
      atsId,
      atsType: 'subscribehr',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role body per `descriptionFormat`. Subscribe-HR cards expose a short HTML
   * summary (`job-desc`) and a plain-text `jobShortDescription`. We prefer the HTML body so
   * markdown / plain conversion is consistent, falling back to the plain-text summary when no
   * HTML body is present.
   */
  private formatDescription(
    html: string | null,
    text: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (html) {
      if (format === DescriptionFormat.HTML) return html;
      if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
      return htmlToPlainText(html) ?? html;
    }
    if (text) {
      // Only a plain-text summary is available; surface it as-is for every format.
      return text;
    }
    return null;
  }

  /**
   * Resolve the Subscribe-HR tenant partner key. An explicit `companySlug` is used directly (a
   * full board URL passed as the slug is reduced to its first sub-domain label); a `companyUrl`
   * on a `*.careers.subscribe-hr.com` host has the tenant taken from its first sub-domain label.
   * Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SUBSCRIBEHR_ROOT_DOMAIN)) {
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
   * Derive the tenant partner key from a Subscribe-HR board URL. The candidate-facing board is
   * `{tenant}.careers.subscribe-hr.com`; the tenant is the first sub-domain label (the part
   * before `.careers.subscribe-hr.com`).
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(SUBSCRIBEHR_ROOT_DOMAIN)) return '';
      // `{tenant}.careers.subscribe-hr.com` → strip the known board-host suffix and take the
      // leading label.
      if (hostname.endsWith(`.${SUBSCRIBEHR_BOARD_HOST_SUFFIX}`)) {
        const label = hostname.slice(0, hostname.length - SUBSCRIBEHR_BOARD_HOST_SUFFIX.length - 1);
        const first = label.split('.').filter(Boolean)[0];
        if (first && first !== 'www') return first;
      }
      // Otherwise fall back to the first non-`www` sub-domain label of any subscribe-hr host.
      const labels = hostname.split('.').filter(Boolean);
      const first = labels[0];
      if (first && first !== 'www') return first;
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveTenantName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return (base || tenant)
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: SubscribeHrJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Infer the employment-type label from the card's attribute bullets (Full Time / Part Time /
   * Casual / Contract / etc.). Returns the cleaned bullet that first matches, else null.
   */
  private detectEmploymentType(attributes: string[]): string | null {
    for (const attr of attributes) {
      if (typeof attr !== 'string') continue;
      const m = SUBSCRIBEHR_EMPLOYMENT_TYPE_REGEX.exec(attr);
      if (m) return this.cleanText(m[0]);
    }
    return null;
  }

  /**
   * Detect remote / home-working roles across the title, location, summary, and attribute text,
   * since the board emits no structured remote flag.
   */
  private detectRemote(
    title: string | null,
    location: string | null,
    summary: string | null,
    attributes: string[],
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, summary, ...attributes];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SUBSCRIBEHR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Run a regex and return its first capture group, trimmed, or null. */
  private firstGroup(html: string, regex: RegExp): string | null {
    const match = regex.exec(html);
    if (match && typeof match[1] === 'string') {
      const v = match[1].trim();
      return v.length > 0 ? v : null;
    }
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /** Decode the handful of HTML entities that appear in card attribute values. */
  private decodeEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
}
