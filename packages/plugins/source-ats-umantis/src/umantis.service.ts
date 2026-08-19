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
  UMANTIS_ROOT_DOMAIN,
  UMANTIS_HOST_TEMPLATE,
  UMANTIS_DE_HOST_TEMPLATE,
  UMANTIS_JOBS_PATH,
  UMANTIS_LANG_QUERY,
  UMANTIS_DEFAULT_RESULTS,
  UMANTIS_MAX_PAGES,
  UMANTIS_HEADERS,
  UMANTIS_VACANCY_LINK_REGEX,
  UMANTIS_DATE_REGEX,
  UMANTIS_REMOTE_REGEX,
} from './umantis.constants';
import { UmantisIndexJob, UmantisDetail, UmantisJob } from './umantis.types';

/**
 * Umantis (Haufe Talent) ATS careers scraper — generic, multi-tenant.
 *
 * Umantis (umantis.com, DACH), Haufe Group's e-recruiting product ("Haufe Talent"),
 * hosts each customer tenant's branded, public, unauthenticated candidate-facing job
 * board on the shared application host, keyed by a stable numeric tenant id:
 *
 *   https://recruitingapp-{tenantId}.umantis.com/Jobs/All        (CH / global host)
 *   https://recruitingapp-{tenantId}.de.umantis.com/Jobs/All     (DE host variant)
 *
 * The board is server-rendered HTML, so the open-roles index is directly crawlable
 * without authentication. It lists every open role as a canonical vacancy anchor of
 * the form `/Vacancies/{ID}/Description/{langCode}`, where the numeric `{ID}` is the
 * stable ATS id and the path (resolved against the tenant host) is the canonical
 * public detail / apply URL. The adapter parses the index for those anchors, then
 * (best-effort, fanned out with Promise.allSettled) fetches each role's detail page
 * to recover the title, location, employment type, posting date, and body.
 *
 * The caller addresses a tenant by `companySlug` (the numeric tenant id, optionally
 * carrying a `.de` host hint, e.g. `5476` or `5476.de`) or by `companyUrl` (any
 * board / vacancy URL on a `umantis.com` host, from which the host + tenant id are
 * derived). An unknown tenant, an HTTP 4xx, a DNS failure, or a malformed body
 * degrades to an empty / partial result rather than throwing, so a single bad tenant
 * never nukes a batch run.
 */
@SourcePlugin({
  site: Site.UMANTIS,
  name: 'Umantis (Haufe Talent)',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class UmantisService implements IScraper {
  private readonly logger = new Logger(UmantisService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Umantis scraper');
      return new JobResponseDto([]);
    }

    const resolved = this.resolveTenant(companySlug, input.companyUrl);
    if (!resolved) {
      this.logger.warn('Could not resolve a Umantis tenant from input');
      return new JobResponseDto([]);
    }
    const { host, tenantId } = resolved;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(UMANTIS_HEADERS);

    const resultsWanted = input.resultsWanted ?? UMANTIS_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Umantis jobs for tenant: ${tenantId} (${host})`);

      const items = await this.fetchJobList(client, host, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`Umantis tenant "${tenantId}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Fan out per-role detail fetches; a single failed detail must not nuke the run.
      const settled = await Promise.allSettled(
        items.map((item) => this.processItem(client, item, host, tenantId, input.descriptionFormat)),
      );

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled' && outcome.value) {
          jobPosts.push(outcome.value);
        } else if (outcome.status === 'rejected') {
          this.logger.warn(`Error processing Umantis role: ${outcome.reason?.message ?? outcome.reason}`);
        }
      }

      this.logger.log(`Umantis total: ${jobPosts.length} jobs for ${tenantId}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Umantis scrape error for ${tenantId}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch + parse the tenant's open-roles index HTML, accumulating up to
   * `resultsWanted` deduped roles. The board renders the full open-roles set in one
   * `/Jobs/All` document; the page loop is a guard against future server-side
   * pagination. An unknown tenant renders an empty / error board; an HTTP 4xx or a
   * missing body degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<UmantisIndexJob[]> {
    const items: UmantisIndexJob[] = [];
    const base = `https://${host}${UMANTIS_JOBS_PATH}?${UMANTIS_LANG_QUERY}`;

    for (let page = 1; page <= UMANTIS_MAX_PAGES; page++) {
      const url = page === 1 ? base : `${base}&page=${page}`;
      const html = await this.fetchHtml(client, url, host);
      if (html == null) break;

      const parsed = this.parseIndex(html, host);
      let added = 0;
      for (const role of parsed) {
        const id = this.cleanText(role.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        added++;
        if (items.length >= resultsWanted) return items;
      }

      // The index is single-document; stop once a page yields no new roles.
      if (added === 0) break;
    }

    return items;
  }

  /** GET a URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    host: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Umantis page not found (HTTP ${status}) for ${host}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`Umantis page fetch failed for ${host}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered index HTML into role fragments. Rather than depend on
   * volatile CSS class names, we anchor on the canonical vacancy links
   * (`/Vacancies/{ID}/Description/{langCode}`) and read the labelled card text
   * immediately around each link.
   */
  private parseIndex(html: string, host: string): UmantisIndexJob[] {
    const out: UmantisIndexJob[] = [];
    const byId = new Map<string, UmantisIndexJob>();

    UMANTIS_VACANCY_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = UMANTIS_VACANCY_LINK_REGEX.exec(html)) !== null) {
      const [, id, langCode] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const url = `https://${host}/Vacancies/${jobId}/Description/${langCode}`;

      // Pull a window of HTML around the link to recover the card's title / fields.
      const windowText = this.cardWindow(html, match.index);

      const role: UmantisIndexJob = {
        id: jobId,
        langCode: this.cleanText(langCode),
        url,
        title: this.titleFromWindow(html, match.index),
        location: null,
        datePosted: this.dateFromText(windowText),
      };

      byId.set(jobId, role);
      out.push(role);
    }

    return out;
  }

  /**
   * Extract a window of plain text around a vacancy link, used to recover the card's
   * fields (posting date etc.). The index renders the card's fields close to its
   * anchor, so a bounded slice on either side captures them without bleeding into
   * siblings.
   */
  private cardWindow(html: string, index: number): string {
    const start = Math.max(0, index - 200);
    const end = Math.min(html.length, index + 600);
    return htmlToPlainText(html.slice(start, end)) ?? '';
  }

  /**
   * Recover the role title from the anchor's link text. The index renders each
   * vacancy title as the text of (or immediately after) its `/Vacancies/...` anchor;
   * we read the first non-empty plain-text token following the link's href.
   */
  private titleFromWindow(html: string, index: number): string | null {
    // Slice from the start of the anchor href to a bounded window after it.
    const slice = html.slice(index, Math.min(html.length, index + 400));
    // The link text sits between the closing `>` of the opening <a> tag and `</a>`.
    const m = /Description\/\d+[^>]*>([\s\S]*?)<\/a>/i.exec(slice);
    const text = m ? htmlToPlainText(m[1]) : null;
    const cleaned = this.cleanText(text);
    if (cleaned) return cleaned;
    // Fallback: first plain-text line in a forward window of the card.
    const fwd = htmlToPlainText(html.slice(index, Math.min(html.length, index + 300))) ?? '';
    const firstLine = fwd.split(/[\r\n]+/).map((l) => this.cleanText(l)).find((l) => !!l);
    return firstLine ?? null;
  }

  /**
   * Process one parsed index role: best-effort fetch its detail page, normalise, and
   * map to a JobPostDto. A detail-fetch failure degrades to the index-level fields.
   */
  private async processItem(
    client: ReturnType<typeof createHttpClient>,
    item: UmantisIndexJob,
    host: string,
    tenantId: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const detail = await this.fetchDetail(client, item, host);
    const job = this.normaliseJob(item, detail, tenantId);
    return this.processJob(job, tenantId, format);
  }

  /**
   * Best-effort fetch + parse of a vacancy detail page. Any failure (HTTP 4xx, DNS,
   * malformed body) degrades to null and the index-level fields are used instead.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    item: UmantisIndexJob,
    host: string,
  ): Promise<UmantisDetail | null> {
    const url = this.cleanText(item.url);
    if (!url) return null;
    const html = await this.fetchHtml(client, `${url}?${UMANTIS_LANG_QUERY}`, host);
    if (html == null) return null;
    try {
      return this.parseDetail(html);
    } catch (err: any) {
      this.logger.warn(`Umantis detail parse failed for ${url}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse a vacancy detail page. The page `<title>` is "{title} | {organisation}";
   * the body carries a free-text location, an optional `DD.MM.YYYY` posting date, and
   * an "Apply here / Hier bewerben" link. All fields are defensively narrowed.
   */
  private parseDetail(html: string): UmantisDetail {
    const detail: UmantisDetail = {};

    const titleTag = /<title>([\s\S]*?)<\/title>/i.exec(html);
    if (titleTag) {
      const raw = this.cleanText(htmlToPlainText(titleTag[1]));
      if (raw) {
        const parts = raw.split('|').map((p) => this.cleanText(p)).filter((p): p is string => !!p);
        if (parts.length >= 2) {
          detail.title = parts[0];
          detail.companyName = parts[parts.length - 1];
        } else if (parts.length === 1) {
          detail.title = parts[0];
        }
      }
    }

    // og:title / og:description as a defensive fallback.
    if (!detail.title) {
      const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
      if (ogTitle) detail.title = this.cleanText(ogTitle[1]);
    }
    const ogDesc = /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (ogDesc) detail.description = this.cleanText(ogDesc[1]);

    // Apply link — the "Application/CheckLogin" target on this or a tenant host.
    const apply = /href=["']([^"']*Application\/CheckLogin[^"']*)["']/i.exec(html);
    if (apply) detail.applyUrl = this.cleanText(apply[1]);

    // Posting date from the body text.
    const plain = htmlToPlainText(html) ?? '';
    detail.datePosted = this.dateFromText(plain);

    return detail;
  }

  /** Build a normalised UmantisJob from index + (optional) detail fragments. */
  private normaliseJob(item: UmantisIndexJob, detail: UmantisDetail | null, tenantId: string): UmantisJob {
    const jobId = this.cleanText(item.id) ?? '';
    const title = this.cleanText(detail?.title) ?? this.cleanText(item.title);
    const locationText = this.cleanText(detail?.location) ?? this.cleanText(item.location);
    const { city, state, country } = this.splitLocation(locationText);
    const datePosted = this.parseDate(detail?.datePosted ?? item.datePosted);

    return {
      jobId,
      url: this.cleanText(item.url) ?? '',
      title,
      companyName: this.cleanText(detail?.companyName) ?? this.deriveCompanyName(tenantId),
      city,
      state,
      country,
      locationText,
      employmentType: this.normaliseEmploymentType(detail?.employmentType),
      datePosted,
      isRemote: this.detectRemote(title, locationText, detail?.description),
      description: this.cleanText(detail?.description),
      applyUrl: this.cleanText(detail?.applyUrl) ?? this.cleanText(item.url),
    };
  }

  /** Map a normalised UmantisJob → JobPostDto. */
  private processJob(job: UmantisJob, tenantId: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenantId);
    // Prefer the recovered job-ad body; fall back to the location line.
    const descriptionSource = job.description ?? job.locationText ?? null;
    const description = this.formatDescription(descriptionSource, format);

    return new JobPostDto({
      id: `umantis-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.UMANTIS,
      atsId,
      atsType: 'umantis',
      department: null,
      employmentType: this.cleanText(job.employmentType),
      applyUrl: this.cleanText(job.applyUrl) ?? jobUrl,
    });
  }

  /**
   * Convert descriptive text per `descriptionFormat`. The body may carry HTML; when
   * present we honour HTML / Markdown / plain as requested.
   */
  private formatDescription(text: string | null, format?: DescriptionFormat): string | null {
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Resolve the tenant host + numeric id. An explicit `companySlug` may be a bare
   * numeric tenant id (`5476`), a numeric id with a `.de` host hint (`5476.de`), or a
   * full board / vacancy URL; a `companyUrl` on a `umantis.com` host has its host +
   * tenant id derived from the `recruitingapp-{tenantId}` sub-domain label. Returns
   * null when neither yields a usable tenant.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { host: string; tenantId: string } | null {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may pass a full board / vacancy URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(UMANTIS_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // Bare numeric id, optionally with a `.de` host hint (e.g. `5476` / `5476.de`).
      const m = /^(\d+)(?:\.(de))?$/i.exec(slug.toLowerCase());
      if (m) {
        const tenantId = m[1];
        const isDe = m[2] === 'de';
        const host = (isDe ? UMANTIS_DE_HOST_TEMPLATE : UMANTIS_HOST_TEMPLATE).replace(
          '{tenantId}',
          tenantId,
        );
        return { host, tenantId };
      }
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  /**
   * Derive the tenant host + numeric id from a Umantis URL. The candidate-facing host
   * forms are `recruitingapp-{tenantId}.umantis.com` and
   * `recruitingapp-{tenantId}.de.umantis.com`; the host is used verbatim and the
   * tenant id is the numeric token in the `recruitingapp-{tenantId}` sub-domain label.
   */
  private tenantFromUrl(value: string): { host: string; tenantId: string } | null {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(UMANTIS_ROOT_DOMAIN)) return null;
      const m = /^recruitingapp-(\d+)\./i.exec(hostname);
      if (!m) return null;
      return { host: hostname, tenantId: m[1] };
    } catch {
      // Malformed URL — no tenant.
      return null;
    }
  }

  /** De-slugify the numeric tenant id into a placeholder display company name. */
  private deriveCompanyName(tenantId: string): string {
    const base = tenantId && tenantId.trim() ? tenantId.trim() : tenantId;
    return `Umantis ${base}`;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. Umantis renders a single free-text location line
   * (e.g. "Munich (Germany)"); we keep a trailing parenthesised / comma token as the
   * country and the leading text as the city, best-effort.
   */
  private extractLocation(job: UmantisJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state /
   * country. Handles "City (Country)" and comma-separated tails.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    // "Munich (Germany)" → city "Munich", country "Germany".
    const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text);
    if (paren) {
      const city = this.cleanText(paren[1]);
      const country = this.cleanText(paren[2]);
      return { city, state: null, country };
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

  /** Detect remote roles from the title, location, or body text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    body: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, body];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (UMANTIS_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise an employment-type token into a readable, trimmed, title-cased label.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned
      .replace(/[_]+/g, ' ')
      .replace(/\bfulltime\b/i, 'full time')
      .replace(/\bparttime\b/i, 'part time')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Find the first `DD.MM.YYYY` token in a block of text, returning it raw. */
  private dateFromText(text: string | null | undefined): string | null {
    const cleaned = this.cleanText(text);
    if (!cleaned) return null;
    const m = UMANTIS_DATE_REGEX.exec(cleaned);
    return m ? m[0] : null;
  }

  /**
   * Parse a `DD.MM.YYYY` value into a `YYYY-MM-DD` string. An absent / malformed
   * value yields null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = UMANTIS_DATE_REGEX.exec(cleaned);
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    const day = dd.padStart(2, '0');
    const month = mm.padStart(2, '0');
    const iso = `${yyyy}-${month}-${day}`;
    const parsed = new Date(iso);
    return isNaN(parsed.getTime()) ? null : iso;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
