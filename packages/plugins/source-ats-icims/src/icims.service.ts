import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import {
  ICIMS_ROOT_DOMAIN,
  ICIMS_PAGE_SIZE,
  ICIMS_DEFAULT_RESULTS,
  ICIMS_MAX_PAGES,
  ICIMS_HEADERS,
  ICIMS_REMOTE_REGEX,
  ICIMS_PAGE_OF_REGEX,
  ICIMS_TITLE_COMPANY_REGEX,
  ICIMS_JOB_ID_REGEX,
  buildIcimsBoardUrl,
} from './icims.constants';
import { IcimsBoardPage, IcimsListItem } from './icims.types';

/**
 * iCIMS ATS careers scraper — generic, multi-tenant.
 *
 * iCIMS candidate-experience boards are server-rendered HTML on a per-tenant
 * subdomain of `icims.com`. The adapter fetches the embeddable board form
 * (`?ss=1&in_iframe=1&pr={page}`) and parses the `iCIMS_JobCardItem` cards,
 * walking `pr` (a 0-based page index) until the board's "Page X of N" pager is
 * exhausted, a short/empty page is seen, or `resultsWanted` is reached.
 *
 * The caller addresses a tenant by `companySlug` (the board subdomain, e.g.
 * `careers-acme`) or by `companyUrl` (any `*.icims.com` board URL). A fetch
 * error or an unknown tenant degrades to an empty/partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.ICIMS,
  name: 'iCIMS',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class IcimsService implements IScraper {
  private readonly logger = new Logger(IcimsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const subdomain = this.resolveSubdomain(input.companySlug, input.companyUrl);
    if (!subdomain) {
      this.logger.warn('Could not resolve an iCIMS subdomain from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ICIMS_HEADERS);

    const resultsWanted = input.resultsWanted ?? ICIMS_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];
    const seen = new Set<string>();
    let companyName: string | null = null;

    try {
      for (let page = 0; page < ICIMS_MAX_PAGES; page++) {
        const html = await this.fetchBoardPage(client, subdomain, page);
        if (html == null) break;

        const parsed = this.parseBoardPage(html);
        if (page === 0) companyName = parsed.companyName;

        for (const item of parsed.items) {
          if (seen.has(item.jobId)) continue;
          seen.add(item.jobId);
          jobPosts.push(this.toJobPost(item, subdomain, companyName));
          if (jobPosts.length >= resultsWanted) break;
        }

        if (jobPosts.length >= resultsWanted) break;
        if (parsed.items.length < ICIMS_PAGE_SIZE) break;
        if (parsed.totalPages != null && page + 1 >= parsed.totalPages) break;
      }

      this.logger.log(`iCIMS total: ${jobPosts.length} jobs for ${subdomain}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted));
    } catch (err: any) {
      this.logger.error(`iCIMS scrape error for ${subdomain}: ${err.message}`);
      return new JobResponseDto(jobPosts, jobPosts.length ? undefined : classifyScrapeError(err)); // partial results
    }
  }

  /** Fetch one board page as HTML. An unknown tenant (HTTP 4xx) degrades to null. */
  private async fetchBoardPage(
    client: ReturnType<typeof createHttpClient>,
    subdomain: string,
    page: number,
  ): Promise<string | null> {
    const url = buildIcimsBoardUrl(subdomain, page);
    this.logger.log(`Fetching iCIMS board page=${page} for ${subdomain}`);
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`iCIMS board returned HTTP ${status} for ${subdomain}`);
        return null;
      }
      throw err;
    }
  }

  /** Parse a board page into job cards + pager metadata. */
  private parseBoardPage(html: string): IcimsBoardPage {
    const $ = cheerio.load(html);

    const titleText = $('title').first().text();
    const companyMatch = ICIMS_TITLE_COMPANY_REGEX.exec(titleText);
    const companyName = companyMatch ? companyMatch[1].trim() : null;

    const pagerMatch = ICIMS_PAGE_OF_REGEX.exec($('body').text());
    const totalPages = pagerMatch ? parseInt(pagerMatch[1], 10) : null;

    const items: IcimsListItem[] = [];
    $('.iCIMS_JobCardItem').each((_, el) => {
      const item = this.parseCard($, $(el));
      if (item) items.push(item);
    });

    return { items, totalPages, companyName };
  }

  /** Parse a single `.iCIMS_JobCardItem` card into a normalised list item. */
  private parseCard(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<any>,
  ): IcimsListItem | null {
    const anchor = card.find('.title a.iCIMS_Anchor, a.iCIMS_Anchor').first();
    const href = anchor.attr('href');
    if (!href) return null;

    const title =
      this.cleanText(anchor.find('h3').first().text()) ??
      this.cleanText(anchor.attr('title')?.replace(/^\s*\d+\s*-\s*/, ''));
    if (!title) return null;

    const url = this.cleanUrl(href);
    const idMatch = ICIMS_JOB_ID_REGEX.exec(url);
    const jobId = idMatch ? idMatch[1] : null;
    if (!jobId) return null;

    const locationRaw = this.cleanText(
      card.find('.header.left span:not(.field-label)').first().text(),
    );
    const { city, state, country } = this.parseLocation(locationRaw);

    const fields = this.parseHeaderFields($, card);
    const department = fields['Category'] ?? null;

    const descriptionSnippet = this.cleanText(
      card.find('.col-xs-12.description').first().text(),
    );

    const isRemote =
      (locationRaw != null && ICIMS_REMOTE_REGEX.test(locationRaw)) ||
      ICIMS_REMOTE_REGEX.test(title);

    return {
      jobId,
      title,
      url,
      city,
      state,
      country,
      locationRaw,
      department,
      descriptionSnippet,
      isRemote,
    };
  }

  /** Collect the `<dt>field</dt><dd>value</dd>` pairs from a card's header group. */
  private parseHeaderFields(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<any>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    card.find('.iCIMS_JobHeaderTag').each((_, el) => {
      const tag = $(el);
      const key = this.cleanText(tag.find('.iCIMS_JobHeaderField').first().text());
      const value = this.cleanText(tag.find('.iCIMS_JobHeaderData').first().text());
      if (key && value) out[key] = value;
    });
    return out;
  }

  /** Map a normalised list item → JobPostDto. */
  private toJobPost(
    item: IcimsListItem,
    subdomain: string,
    companyName: string | null,
  ): JobPostDto {
    return new JobPostDto({
      id: `icims-${subdomain}-${item.jobId}`,
      title: item.title,
      companyName: companyName ?? this.companyFromSubdomain(subdomain),
      jobUrl: item.url,
      location: this.buildLocation(item),
      description: item.descriptionSnippet,
      isRemote: item.isRemote,
      site: Site.ICIMS,
      atsId: item.jobId,
      atsType: 'icims',
      department: item.department,
      applyUrl: item.url,
    });
  }

  /** Surface the card's location parts as a LocationDto, or null. */
  private buildLocation(item: IcimsListItem): LocationDto | null {
    if (!item.city && !item.state && !item.country) {
      return item.isRemote ? new LocationDto({ city: 'Remote' }) : null;
    }
    return new LocationDto({
      city: item.city,
      state: item.state,
      country: item.country,
    });
  }

  /**
   * Parse an iCIMS location string (`{country}-{state}-{city}`, e.g.
   * `US-CA-Santa Cruz`) into parts. Multi-location cells (`|`/`;`-separated)
   * take the first entry; a city with an internal dash (`Winston-Salem`) is
   * preserved.
   */
  private parseLocation(raw: string | null): {
    city: string | null;
    state: string | null;
    country: string | null;
  } {
    if (!raw) return { city: null, state: null, country: null };
    const first = raw.split(/[|;]/)[0].trim();
    const parts = first.split('-').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    if (parts.length === 2) {
      return { country: parts[0], state: null, city: parts[1] };
    }
    return {
      country: parts[0],
      state: parts[1],
      city: parts.slice(2).join('-'),
    };
  }

  /**
   * Resolve a tenant subdomain from a `companyUrl` (any `*.icims.com` URL) or a
   * `companySlug` (a bare subdomain, or a full/partial icims URL). Returns an
   * empty string when neither yields one.
   */
  private resolveSubdomain(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl) {
      const fromUrl = this.subdomainFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    const slug = companySlug?.trim();
    if (!slug) return '';
    if (/^https?:\/\//i.test(slug) || slug.includes(ICIMS_ROOT_DOMAIN)) {
      const fromUrl = this.subdomainFromUrl(slug);
      if (fromUrl) return fromUrl;
    }
    // Bare slug: strip any accidental protocol/path and lowercase.
    return slug.replace(/^https?:\/\//i, '').split('/')[0].split('.')[0].toLowerCase();
  }

  /** Extract the `{subdomain}` from a `{subdomain}.icims.com` URL. */
  private subdomainFromUrl(rawUrl: string): string {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    try {
      const host = new URL(withScheme).hostname.toLowerCase();
      if (!host.endsWith(ICIMS_ROOT_DOMAIN)) return '';
      const sub = host.slice(0, host.length - ICIMS_ROOT_DOMAIN.length);
      return sub && sub !== 'www' ? sub : '';
    } catch {
      return '';
    }
  }

  /** Drop the query/hash from a board job URL, keeping origin + path. */
  private cleanUrl(href: string): string {
    try {
      const u = new URL(href);
      return `${u.origin}${u.pathname}`;
    } catch {
      return href.split('?')[0];
    }
  }

  /** Title-case a subdomain (minus a leading `careers-`) as a fallback name. */
  private companyFromSubdomain(subdomain: string): string {
    return subdomain
      .replace(/^careers-/, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Trim a string, collapsing whitespace; null for empty/non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  }
}
