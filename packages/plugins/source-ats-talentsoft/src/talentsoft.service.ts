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
  TALENTSOFT_CAREERS_HOST_TEMPLATE,
  TALENTSOFT_ROOT_DOMAIN,
  TALENTSOFT_RSS_PATH,
  TALENTSOFT_DEFAULT_LCID,
  TALENTSOFT_DEFAULT_RESULTS,
  TALENTSOFT_HEADERS,
  TALENTSOFT_ITEM_REGEX,
  TALENTSOFT_TAG_REGEX_TEMPLATE,
  TALENTSOFT_REFERENCE_REGEX,
  TALENTSOFT_LINK_ID_REGEX,
  TALENTSOFT_REMOTE_REGEX,
} from './talentsoft.constants';
import { TalentsoftFeed, TalentsoftOffer } from './talentsoft.types';

/**
 * Talentsoft (Cegid Talentsoft) ATS careers scraper — generic, multi-tenant.
 *
 * Talentsoft (talentsoft.com / talent-soft.com, France) hosts each customer's
 * public career site on its own `talent-soft.com` sub-domain
 * (`{tenant}-recrute.talent-soft.com`). The site's structured, unauthenticated
 * open-roles surface is the per-tenant RSS export handler
 * (`GET /handlers/offerRss.ashx?LCID={lcid}`), which returns every published
 * offer in one envelope — there is no server-side pagination, so we fetch once
 * and slice client-side to honour `resultsWanted`.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `elis`) or by a full `companyUrl` on the tenant career host (whose host is
 * used verbatim, so non-`-recrute` variants such as `-career` / `careers` are
 * supported). A single fetch error, an unknown tenant (HTTP 4xx), or a
 * malformed / non-XML payload degrades to an empty result rather than throwing,
 * so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.TALENTSOFT,
  name: 'Talentsoft',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TalentsoftService implements IScraper {
  private readonly logger = new Logger(TalentsoftService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Talentsoft scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Talentsoft career host from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TALENTSOFT_HEADERS);

    const resultsWanted = input.resultsWanted ?? TALENTSOFT_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Talentsoft jobs from: ${host}`);

      // The RSS export returns every published offer for the tenant at once.
      const feed = await this.fetchFeed(client, host);
      if (!feed) {
        this.logger.warn(`Talentsoft feed for "${host}" returned no offers`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveCompanyName(companySlug, host);
      this.collect(feed.offers, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Talentsoft total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Talentsoft scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch and parse the tenant's RSS offer export. */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<TalentsoftFeed | null> {
    const url = `${host}${TALENTSOFT_RSS_PATH}?LCID=${TALENTSOFT_DEFAULT_LCID}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const xml = typeof response.data === 'string' ? response.data : '';
      if (!xml || !/<item\b/i.test(xml)) {
        this.logger.warn(`Talentsoft feed "${host}" returned no parseable items`);
        return null;
      }
      return this.parseFeed(xml);
    } catch (err: any) {
      // An unknown sub-domain / disabled feed returns HTTP 404 (or other 4xx);
      // treat that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Talentsoft feed "${host}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Parse RSS XML into a normalised feed (offers with decoded fields). */
  private parseFeed(xml: string): TalentsoftFeed {
    const offers: TalentsoftOffer[] = [];
    TALENTSOFT_ITEM_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TALENTSOFT_ITEM_REGEX.exec(xml)) !== null) {
      const block = match[1] ?? '';
      const rawTitle = this.extractTag(block, 'title');
      const link = this.extractTag(block, 'link');
      const description = this.extractTag(block, 'description');
      const pubDate = this.extractTag(block, 'pubDate');
      const guid = this.extractTag(block, 'guid');
      const categories = this.extractAllTags(block, 'category');

      const reference = this.extractReference(rawTitle, link);
      const displayTitle = this.stripReference(rawTitle);

      offers.push({
        title: rawTitle,
        reference,
        displayTitle,
        link,
        description,
        categories,
        pubDate,
        guid,
      });
    }
    return {
      title: this.extractTag(xml, 'title'),
      language: this.extractTag(xml, 'language'),
      offers,
    };
  }

  /** Map raw offers → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    offers: TalentsoftOffer[],
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const offer of offers) {
      try {
        const post = this.processOffer(offer, companyName, format);
        if (!post) continue;
        // processOffer guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Talentsoft offer "${offer?.title}": ${err.message}`);
      }
    }
  }

  private processOffer(
    offer: TalentsoftOffer,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = offer.displayTitle ?? offer.title;
    if (!title) return null;

    const atsId = String(offer.reference ?? offer.guid ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(offer);
    if (!jobUrl) return null;

    const rawHtml = offer.description ?? null;
    const description = this.formatDescription(rawHtml, format);

    return new JobPostDto({
      id: `talentsoft-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(offer),
      description,
      datePosted: this.parseDate(offer.pubDate ?? offer.pubdate),
      isRemote: this.detectRemote(offer),
      emails: extractEmails(description),
      site: Site.TALENTSOFT,
      atsId,
      atsType: 'talentsoft',
      department: this.extractDepartment(offer),
      employmentType: this.extractEmploymentType(offer),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The RSS `<description>` is
   * an HTML-encoded body (entities decoded during parse); we surface it as HTML,
   * Markdown, or plain text on request, defaulting to plain text.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the tenant's career host. An explicit `companySlug` is expanded into
   * the canonical `{tenant}-recrute.talent-soft.com` host; a `companyUrl` on the
   * `talent-soft.com` domain has its origin used verbatim (so non-`-recrute`
   * sub-domain variants are supported). Returns an empty string when neither
   * yields a usable host.
   */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (hostname.endsWith(TALENTSOFT_ROOT_DOMAIN)) {
          return `${u.protocol}//${u.host}`;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A caller may also pass a bare host (e.g. "elis-recrute.talent-soft.com").
      if (slug.includes(TALENTSOFT_ROOT_DOMAIN)) {
        const host = slug.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        return `https://${host}`;
      }
      return TALENTSOFT_CAREERS_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
    }
    return '';
  }

  /** Build the public apply / offer-detail URL from the item's `<link>`. */
  private buildJobUrl(offer: TalentsoftOffer): string | null {
    const link = offer.link ?? offer.url;
    if (typeof link === 'string' && link.trim()) {
      const trimmed = link.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
    }
    return null;
  }

  /** Extract the stable offer reference from the title, else from the link. */
  private extractReference(title: string | null, link: string | null): string | null {
    if (title) {
      const m = title.match(TALENTSOFT_REFERENCE_REGEX);
      if (m && m[1]) return m[1].trim();
    }
    if (link) {
      const m = link.match(TALENTSOFT_LINK_ID_REGEX);
      if (m && m[1]) return m[1];
      // `?reference=2025-15918` query form.
      const q = link.match(/[?&]reference=([^&#]+)/i);
      if (q && q[1]) {
        try {
          return decodeURIComponent(q[1]);
        } catch {
          return q[1];
        }
      }
    }
    return null;
  }

  /** Remove the leading `{reference} - ` token from a display title, if present. */
  private stripReference(title: string | null): string | null {
    if (!title) return null;
    const stripped = title.replace(TALENTSOFT_REFERENCE_REGEX, '').trim();
    return stripped || title.trim();
  }

  private deriveCompanyName(companySlug: string | undefined, host: string): string {
    let base = companySlug && companySlug.trim() ? companySlug.trim() : '';
    if (!base) {
      try {
        const label = new URL(host).hostname.split('.')[0] || '';
        base = label.replace(/-(recrute|career|careers|cand|recruit)$/i, '');
      } catch {
        base = host;
      }
    }
    base = base.replace(/-(recrute|career|careers|cand|recruit)$/i, '');
    return (base || host)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Talentsoft RSS items do not expose a structured location, but the contract /
   * job-family `<category>` labels and the HTML body often name a city/region.
   * We surface the best free-text location segment found in the categories as a
   * city, leaving it null when nothing usable is present.
   */
  private extractLocation(offer: TalentsoftOffer): LocationDto | null {
    const cats = Array.isArray(offer.categories) ? offer.categories : [];
    for (const cat of cats) {
      if (typeof cat !== 'string') continue;
      const v = cat.trim();
      // Skip obvious contract-type labels; a location category is usually a
      // place name without a job-family path separator.
      if (!v || /^(cdi|cdd|stage|alternance|interim|intérim|freelance)$/i.test(v)) continue;
      if (v.includes('/')) continue;
      // Heuristic: a short, capitalised token is more likely a place than a role.
      if (v.length <= 40 && /^[A-ZÀ-Ÿ]/.test(v) && !/\s(h\/f|f\/h)\b/i.test(v)) {
        return new LocationDto({ city: v });
      }
    }
    return null;
  }

  /** Use the first job-family-style `<category>` (with a path separator) as the department. */
  private extractDepartment(offer: TalentsoftOffer): string | null {
    const cats = Array.isArray(offer.categories) ? offer.categories : [];
    for (const cat of cats) {
      if (typeof cat !== 'string') continue;
      const v = cat.trim();
      if (!v) continue;
      if (this.isContractType(v)) continue;
      // Job-family labels are paths like "Industrielle/Opérateur(trice)…".
      if (v.includes('/')) return v.split('/')[0].trim();
      return v;
    }
    return null;
  }

  /** Use a contract-type `<category>` (CDI/CDD/Stage/Alternance/…) as employment type. */
  private extractEmploymentType(offer: TalentsoftOffer): string | null {
    const cats = Array.isArray(offer.categories) ? offer.categories : [];
    for (const cat of cats) {
      if (typeof cat !== 'string') continue;
      const v = cat.trim();
      if (v && this.isContractType(v)) return v;
    }
    return null;
  }

  private isContractType(value: string): boolean {
    return /^(cdi|cdd|stage|alternance|apprentissage|interim|intérim|freelance|full[\s-]?time|part[\s-]?time|temps\s+(plein|partiel)|contract|permanent|internship)$/i.test(
      value.trim(),
    );
  }

  /** Detect remote roles from the title, categories, or description body. */
  private detectRemote(offer: TalentsoftOffer): boolean {
    const haystacks: Array<string | null | undefined> = [
      offer.title,
      offer.displayTitle,
      offer.description,
    ];
    if (Array.isArray(offer.categories)) haystacks.push(...offer.categories);
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (TALENTSOFT_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Parse an RFC-822 / ISO-8601 string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }

  /** Extract and decode the inner text of the first matching child element. */
  private extractTag(block: string, tag: string): string | null {
    const re = new RegExp(TALENTSOFT_TAG_REGEX_TEMPLATE.replace(/\{tag\}/g, tag), 'i');
    const m = block.match(re);
    if (!m) return null;
    return this.cleanValue(m[1]);
  }

  /** Extract and decode every matching child element's inner text. */
  private extractAllTags(block: string, tag: string): string[] {
    const re = new RegExp(TALENTSOFT_TAG_REGEX_TEMPLATE.replace(/\{tag\}/g, tag), 'gi');
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const v = this.cleanValue(m[1]);
      if (v) out.push(v);
    }
    return out;
  }

  /** Strip CDATA wrappers and decode the common XML/HTML entities. */
  private cleanValue(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    let v = raw.trim();
    const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) v = cdata[1];
    v = this.decodeEntities(v).trim();
    return v || null;
  }

  /**
   * Decode the XML/HTML entities the feed emits. The body is double-encoded
   * (e.g. `&lt;b&gt;` for bold), so a single pass yields the inner HTML which we
   * then hand to the description formatter.
   */
  private decodeEntities(input: string): string {
    return input
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => {
        const code = Number(d);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&amp;/g, '&');
  }
}
