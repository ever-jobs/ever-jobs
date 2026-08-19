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
} from '@ever-jobs/common';
import {
  SKEELED_HOST,
  SKEELED_BOARD_PATH_TEMPLATE,
  SKEELED_OFFER_PATH_TEMPLATE,
  SKEELED_OFFER_QUERY,
  SKEELED_OBJECT_ID_RE,
  SKEELED_BOARD_URL_RE,
  SKEELED_OFFER_URL_RE,
  SKEELED_NUXT_DATA_ID,
  SKEELED_OFFER_ANCHOR_SELECTOR,
  SKEELED_CARD_TITLE_SELECTOR,
  SKEELED_LANGUAGE_FALLBACKS,
  SKEELED_DEFAULT_LANGUAGE,
  SKEELED_DEFAULT_RESULTS,
  SKEELED_HEADERS,
} from './skeeled.constants';
import {
  SkeeledOffer,
  SkeeledAddress,
  SkeeledContract,
  SkeeledI18nText,
  SkeeledListingItem,
} from './skeeled.types';

/**
 * Skeeled talent-acquisition platform scraper — generic, multi-tenant.
 *
 * Skeeled is a Luxembourg-based predictive talent-acquisition / applicant-
 * tracking platform. Every customer tenant publishes a public, anonymous job
 * board at `https://app.skeeled.com/board/{boardId}`, server-rendered (Nuxt
 * SSR) with the full offer catalogue embedded in a `<script id="__NUXT_DATA__">`
 * JSON data island. Individual offers live at
 * `https://app.skeeled.com/offer/c/{offerId}`.
 *
 * This adapter fetches the board page once and parses the offers from the SSR
 * data island (no pagination is needed — the island carries every published
 * role). The island is a flattened reference array, so a dereferencing decoder
 * reconstructs each offer wrapper (title / description i18n maps, structured
 * address, contract, salary, jobCategory). If the island is missing or
 * unparseable, a layered fallback scrapes the rendered offer cards directly to
 * still yield title + url + atsId.
 *
 * Tenant resolution: the 24-hex board id is taken from `companySlug`, or parsed
 * from a `companyUrl` of the form `…/board/{boardId}`. A single fetch error, an
 * unknown board (HTTP 4xx), or a malformed payload degrades to an empty/partial
 * result rather than throwing, so a single tenant never aborts a batch run.
 *
 * No authentication is required. The authenticated REST API is not used.
 */
@SourcePlugin({
  site: Site.SKEELED,
  name: 'Skeeled',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SkeeledService implements IScraper {
  private readonly logger = new Logger(SkeeledService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Skeeled scraper');
      return new JobResponseDto([]);
    }

    const boardId = this.resolveBoardId(input.companySlug, input.companyUrl);
    if (!boardId) {
      this.logger.warn('Could not resolve a Skeeled board id from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SKEELED_HEADERS);

    const resultsWanted = input.resultsWanted ?? SKEELED_DEFAULT_RESULTS;
    const language = this.resolveLanguage(input);
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Skeeled board: ${boardId}`);

      const boardUrl = `${SKEELED_HOST}${SKEELED_BOARD_PATH_TEMPLATE.replace('{board}', encodeURIComponent(boardId))}`;
      let html: string;
      try {
        const response = await client.get<string>(boardUrl, { responseType: 'text' });
        html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 400 || status === 403 || status === 404) {
          this.logger.warn(`Skeeled board not found (HTTP ${status}) for ${boardId}`);
          return new JobResponseDto([], classifyScrapeError(err));
        }
        throw err;
      }

      if (!html) {
        this.logger.warn(`Skeeled board returned an empty body for ${boardId}`);
        return new JobResponseDto([]);
      }

      // Primary path: decode the SSR data island.
      let items = this.parseFromNuxtData(html, language);
      // Fallback path: scrape rendered offer cards when the island is absent/empty.
      if (items.length === 0) {
        this.logger.warn(
          `Skeeled: no offers from data island for ${boardId}; falling back to HTML card scrape`,
        );
        items = this.parseFromHtmlCards(html);
      }

      const companyName = this.resolveCompanyName(items, boardId);

      for (const item of items) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.mapToJobPost(item, companyName, input.descriptionFormat);
          if (!post) continue;
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Skeeled offer ${item.offerId}: ${err.message}`);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Skeeled total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Skeeled scrape error for ${boardId}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Primary parser: extract and decode the Nuxt SSR JSON data island, then
   * dereference each offer wrapper into a flat {@link SkeeledListingItem}.
   * Returns an empty array on any parse failure (the caller falls back).
   */
  private parseFromNuxtData(html: string, language: string): SkeeledListingItem[] {
    try {
      const arr = this.extractNuxtArray(html);
      if (!arr) return [];

      // Resolve a value (which may be an integer reference into `arr`) into a
      // plain JS value, guarding against cycles and runaway depth.
      const resolve = (value: unknown, depth = 0, seen = new Set<number>()): unknown => {
        if (typeof value !== 'number' || !Number.isInteger(value)) return value;
        if (value < 0 || value >= arr.length || seen.has(value) || depth > 12) {
          return undefined;
        }
        const next = new Set(seen);
        next.add(value);
        const target = arr[value];
        if (Array.isArray(target)) {
          return target.map((v) => resolve(v, depth + 1, next));
        }
        if (target && typeof target === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
            out[k] = resolve(v, depth + 1, next);
          }
          return out;
        }
        return target;
      };

      const items: SkeeledListingItem[] = [];
      for (let i = 0; i < arr.length; i += 1) {
        const raw = arr[i];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const keys = Object.keys(raw as Record<string, unknown>);
        // Offer wrappers carry both `information` and `url`.
        if (!keys.includes('information') || !keys.includes('url')) continue;

        const offer = resolve(i) as SkeeledOffer | undefined;
        if (!offer || typeof offer !== 'object') continue;

        const item = this.offerToItem(offer, language);
        if (item) items.push(item);
      }
      return items;
    } catch (err: any) {
      this.logger.warn(`Skeeled: data-island parse error: ${err.message}`);
      return [];
    }
  }

  /**
   * Locate and JSON-parse the `__NUXT_DATA__` island from the board HTML.
   * Returns the flattened reference array, or null when absent/invalid.
   */
  private extractNuxtArray(html: string): unknown[] | null {
    const $ = cheerio.load(html);
    const raw = $(`script#${SKEELED_NUXT_DATA_ID}`).first().contents().text();
    const json = (raw || '').trim();
    if (!json) return null;
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Convert a dereferenced offer wrapper into a flat listing item. */
  private offerToItem(offer: SkeeledOffer, language: string): SkeeledListingItem | null {
    const canonical = offer.url?.canonical ?? null;
    const offerId =
      this.extractOfferId(canonical) ?? (typeof offer._id === 'string' ? offer._id : null);
    if (!offerId) return null;

    const info = offer.information ?? {};
    const title = this.pickI18n(info.title, language);
    if (!title) return null;

    const jobUrl = canonical || this.buildOfferUrl(offerId, language);
    const descriptionHtml = this.pickI18n(info.description, language);
    const companyName = this.deriveBrandName(offer.presentation?.logo?.name);

    return {
      offerId,
      title,
      jobUrl,
      descriptionHtml: descriptionHtml || null,
      address: info.address ?? null,
      contract: info.contract ?? null,
      jobCategory: typeof info.jobCategory === 'string' ? info.jobCategory : null,
      companyName,
    };
  }

  /**
   * Fallback parser: scrape rendered offer cards from the board HTML. Each card
   * is an anchor to `/offer/c/{id}` whose title text is in a `.v-card-title`
   * element. Produces degraded items (no description / structured location).
   */
  private parseFromHtmlCards(html: string): SkeeledListingItem[] {
    const items: SkeeledListingItem[] = [];
    try {
      const $ = cheerio.load(html);
      const seen = new Set<string>();
      $(SKEELED_OFFER_ANCHOR_SELECTOR).each((_, el) => {
        try {
          const $a = $(el);
          const href = $a.attr('href') ?? '';
          const offerId = this.extractOfferId(href);
          if (!offerId || seen.has(offerId)) return;

          // Title: dedicated card-title element, else the anchor's own text.
          let title = $a.find(SKEELED_CARD_TITLE_SELECTOR).first().text().trim();
          if (!title) title = $a.text().trim().split('\n')[0].trim();
          if (!title) return;

          const jobUrl = href.startsWith('http') ? href : `${SKEELED_HOST}${href}`;
          seen.add(offerId);
          items.push({
            offerId,
            title,
            jobUrl,
            descriptionHtml: null,
            address: null,
            contract: null,
            jobCategory: null,
            companyName: null,
          });
        } catch (err: any) {
          this.logger.warn(`Skeeled: error parsing offer card: ${err.message}`);
        }
      });
    } catch (err: any) {
      this.logger.warn(`Skeeled: HTML card parse error: ${err.message}`);
    }
    return items;
  }

  /** Map a listing item to a `JobPostDto`; returns null for invalid items. */
  private mapToJobPost(
    item: SkeeledListingItem,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = item.title?.trim();
    if (!title) return null;

    const atsId = item.offerId?.trim();
    if (!atsId) return null;

    const rawDescription = item.descriptionHtml ?? null;
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

    const resolvedCompany = item.companyName?.trim() || companyName;

    return new JobPostDto({
      id: `skeeled-${atsId}`,
      title,
      companyName: resolvedCompany,
      jobUrl: item.jobUrl,
      location: this.extractLocation(item.address),
      description,
      datePosted: null,
      isRemote: this.detectRemote(item),
      emails: extractEmails(description),
      site: Site.SKEELED,
      atsId,
      atsType: 'skeeled',
      department: item.jobCategory ? this.humanise(item.jobCategory) : null,
      applyUrl: item.jobUrl,
    });
  }

  /**
   * Resolve the 24-hex board id from an explicit `companySlug` or by parsing a
   * `companyUrl` of the form `…/board/{boardId}`. Returns an empty string when
   * neither yields a valid board id.
   */
  private resolveBoardId(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (SKEELED_OBJECT_ID_RE.test(slug)) return slug.toLowerCase();
      // A slug may itself be a board URL.
      const fromUrl = slug.match(SKEELED_BOARD_URL_RE);
      if (fromUrl) return fromUrl[1].toLowerCase();
    }
    if (companyUrl && companyUrl.trim()) {
      const url = companyUrl.trim();
      const boardMatch = url.match(SKEELED_BOARD_URL_RE);
      if (boardMatch) return boardMatch[1].toLowerCase();
      // A bare 24-hex id passed as a URL.
      try {
        const u = new URL(url);
        const lastSeg = u.pathname.split('/').filter(Boolean).pop() ?? '';
        if (SKEELED_OBJECT_ID_RE.test(lastSeg)) return lastSeg.toLowerCase();
      } catch {
        // Malformed URL — fall through.
      }
    }
    return '';
  }

  /** Extract the public offer id (24-hex) from a `/offer/c/{id}` URL. */
  private extractOfferId(url: string | null | undefined): string | null {
    if (!url) return null;
    const match = url.match(SKEELED_OFFER_URL_RE);
    return match ? match[1].toLowerCase() : null;
  }

  /** Build a public offer URL for a given offer id and language. */
  private buildOfferUrl(offerId: string, language: string): string {
    const path = SKEELED_OFFER_PATH_TEMPLATE.replace('{offer}', encodeURIComponent(offerId));
    return `${SKEELED_HOST}${path}?${SKEELED_OFFER_QUERY}&language=${encodeURIComponent(language)}`;
  }

  /**
   * Pick a localised string from an i18n map using the requested language,
   * then the configured fallbacks (en/fr/nl/de), then the first non-empty
   * value present. Returns null when no usable string exists.
   */
  private pickI18n(
    map: SkeeledI18nText | null | undefined,
    language: string,
  ): string | null {
    if (!map || typeof map !== 'object') return null;
    const tryKey = (key: string): string | null => {
      const value = map[key];
      return typeof value === 'string' && value.trim() ? value : null;
    };

    const requested = tryKey(language);
    if (requested) return requested;
    for (const fallback of SKEELED_LANGUAGE_FALLBACKS) {
      const value = tryKey(fallback);
      if (value) return value;
    }
    for (const value of Object.values(map)) {
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  }

  /**
   * Determine the requested offer language from the caller input, defaulting to
   * English. (`ScraperInputDto` has no dedicated language field, so we use the
   * platform default; the i18n picker degrades gracefully per offer.)
   */
  private resolveLanguage(_input: ScraperInputDto): string {
    return SKEELED_DEFAULT_LANGUAGE;
  }

  /**
   * Resolve a company / tenant display name. Prefers a brand name derived from
   * an offer's logo asset name; falls back to a name derived from the board id.
   */
  private resolveCompanyName(items: SkeeledListingItem[], boardId: string): string {
    for (const item of items) {
      if (item.companyName && item.companyName.trim()) return item.companyName.trim();
    }
    return `Skeeled ${boardId.slice(0, 8)}`;
  }

  /**
   * Derive a brand / company name from a logo asset name (e.g. `"CBL Logo"` →
   * `"CBL"`). Returns null when no usable name is present.
   */
  private deriveBrandName(logoName: string | null | undefined): string | null {
    if (!logoName || !logoName.trim()) return null;
    const cleaned = logoName
      .trim()
      .replace(/\b(logo|brand|image|picture|banner)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return cleaned || logoName.trim();
  }

  /** Convert a snake_case / lowercase token into a Title-Cased label. */
  private humanise(token: string): string {
    return token
      .replace(/[-_]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Build a `LocationDto` from the structured Skeeled address. `country` is an
   * ISO alpha-2 code; we pass it through as the country value.
   */
  private extractLocation(address: SkeeledAddress | null | undefined): LocationDto | null {
    if (!address) return null;
    const city = address.city?.trim() || null;
    const country = address.country?.trim() || null;
    if (!city && !country) return null;
    return new LocationDto({ city, state: null, country });
  }

  /**
   * Detect remote roles from the contract employment types or job title.
   * Skeeled has no dedicated remote flag in the public payload.
   */
  private detectRemote(item: SkeeledListingItem): boolean {
    const haystacks: (string | null | undefined)[] = [
      item.title,
      item.jobCategory,
      ...(this.employmentTypeStrings(item.contract)),
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh') || v.includes('télétravail')) {
        return true;
      }
    }
    return false;
  }

  /** Flatten the contract employment-type tokens into a string array. */
  private employmentTypeStrings(contract: SkeeledContract | null | undefined): string[] {
    if (!contract) return [];
    const out: string[] = [];
    if (typeof contract.type === 'string') out.push(contract.type);
    if (Array.isArray(contract.employmentTypes)) {
      for (const t of contract.employmentTypes) {
        if (typeof t === 'string') out.push(t);
      }
    }
    return out;
  }
}
