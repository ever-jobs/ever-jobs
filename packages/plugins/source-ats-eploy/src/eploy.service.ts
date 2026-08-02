import * as cheerio from 'cheerio';
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
  EPLOY_STAGING_HOST_TEMPLATE,
  EPLOY_DATAFEED_PATH,
  EPLOY_FORMAT_PARAM,
  EPLOY_DEFAULT_RESULTS,
  EPLOY_HEADERS,
} from './eploy.constants';
import { EployVacancyItem, EployFeedMeta } from './eploy.types';

/**
 * Eploy hosted career-site scraper — generic, multi-tenant.
 *
 * Eploy powers public career sites for UK public-sector employers, councils,
 * NHS trusts, police forces, and private-sector companies. Each tenant runs
 * their own branded career site on a custom domain (e.g.
 * `jobs.islington.gov.uk`) or, during implementation, on a staging sub-domain
 * under `eploy.net`.
 *
 * The scraper fetches the **public, anonymous XML datafeed** that every Eploy
 * career site exposes at `/feeds/datafeed.ashx?Format=xml`. This is the same
 * feed Eploy customers use to syndicate roles to external job boards. No
 * authentication is required.
 *
 * The datafeed returns a single XML document (`<Vacancies Count="N">`) with
 * all open roles embedded — no pagination is needed. We parse the XML with
 * cheerio in XML mode, map each `<Item>` to `JobPostDto`, and de-duplicate by
 * `VacancyID` within the run.
 *
 * A missing tenant, an HTTP error, or a malformed payload degrades to an
 * empty/partial result — never throws — so a single tenant never aborts a
 * batch run. The authenticated RESTful API (`/api/vacancies/search`) requires
 * credentials and is deliberately not used.
 */
@SourcePlugin({
  site: Site.EPLOY,
  name: 'Eploy',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class EployService implements IScraper {
  private readonly logger = new Logger(EployService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Eploy scraper');
      return new JobResponseDto([]);
    }

    const tenantUrl = this.resolveTenantUrl(input.companySlug, input.companyUrl);
    if (!tenantUrl) {
      this.logger.warn('Could not resolve an Eploy tenant URL from input');
      return new JobResponseDto([]);
    }

    const companyName = this.deriveCompanyName(tenantUrl, input.companySlug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(EPLOY_HEADERS);

    const resultsWanted = input.resultsWanted ?? EPLOY_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Eploy datafeed for tenant: ${tenantUrl}`);

      const feedUrl = `${tenantUrl}${EPLOY_DATAFEED_PATH}`;
      let xmlData: string;

      try {
        const response = await client.get<string>(feedUrl, {
          params: { Format: EPLOY_FORMAT_PARAM },
          responseType: 'text',
        });
        xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 400 || status === 404 || status === 403) {
          this.logger.warn(
            `Eploy datafeed not found (HTTP ${status}) for ${tenantUrl}`,
          );
          return new JobResponseDto([]);
        }
        throw err;
      }

      const feed = this.parseFeed(xmlData);
      this.logger.log(
        `Eploy datafeed parsed: ${feed.count} total vacancies reported, ` +
        `${feed.items.length} items in feed for ${tenantUrl}`,
      );

      for (const item of feed.items) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, tenantUrl, companyName, input.descriptionFormat);
          if (!post) continue;
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Eploy vacancy ${item?.VacancyID ?? '?'}: ${err.message}`,
          );
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Eploy total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Eploy scrape error for ${tenantUrl}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted));
    }
  }

  /**
   * Parse the raw XML string from the datafeed into structured items.
   * Uses cheerio in XML mode so element names are preserved case-sensitively.
   * Returns an empty feed object on any parse failure.
   */
  private parseFeed(xml: string): EployFeedMeta {
    try {
      const $ = cheerio.load(xml, { xmlMode: true });

      const root = $('Vacancies');
      const countAttr = root.attr('Count');
      const count = countAttr ? parseInt(countAttr, 10) : 0;

      const items: EployVacancyItem[] = [];
      root.find('Item').each((_i, el) => {
        const $el = $(el);
        items.push({
          VacancyID: $el.find('VacancyID').text().trim() || null,
          Title: $el.find('Title').text().trim() || null,
          Link: $el.find('Link').text().trim() || null,
          Description: $el.find('Description').text().trim() || null,
          Benefits: $el.find('Benefits').text().trim() || null,
          Location: $el.find('Location').text().trim() || null,
          LocationID: $el.find('LocationID').text().trim() || null,
          Position: $el.find('Position').text().trim() || null,
          PositionID: $el.find('PositionID').text().trim() || null,
          Industry: $el.find('Industry').text().trim() || null,
          IndustryID: $el.find('IndustryID').text().trim() || null,
          VacancyType: $el.find('VacancyType').text().trim() || null,
          VacancyTypeID: $el.find('VacancyTypeID').text().trim() || null,
          DisplaySalary: $el.find('DisplaySalary').text().trim() || null,
          Company: $el.find('Company').text().trim() || null,
          DateCreated: $el.find('DateCreated').text().trim() || null,
          DatePosted: $el.find('DatePosted').text().trim() || null,
          Reference: $el.find('Reference').text().trim() || null,
          Qualifications: $el.find('Qualifications').text().trim() || null,
        });
      });

      return { count: isNaN(count) ? items.length : count, items };
    } catch (err: any) {
      this.logger.warn(`Eploy XML parse error: ${err.message}`);
      return { count: 0, items: [] };
    }
  }

  /** Map a raw vacancy item to a JobPostDto; returns null for invalid items. */
  private processItem(
    item: EployVacancyItem,
    tenantUrl: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = item.Title?.trim();
    if (!title) return null;

    const atsId = item.VacancyID?.trim();
    if (!atsId) return null;

    const jobUrl = item.Link?.trim() || `${tenantUrl}/vacancies/${atsId}/`;

    // Merge description HTML with benefits HTML (if present) before conversion.
    const rawDescription = this.mergeDescription(item.Description, item.Benefits);
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

    const department =
      item.Position?.trim() ||
      item.Industry?.trim() ||
      item.VacancyType?.trim() ||
      null;

    const resolvedCompanyName =
      item.Company?.trim() || companyName;

    return new JobPostDto({
      id: `eploy-${atsId}`,
      title,
      companyName: resolvedCompanyName,
      jobUrl,
      location: this.extractLocation(item),
      description,
      datePosted: this.parseDate(item.DatePosted ?? item.DateCreated),
      isRemote: this.detectRemote(item),
      emails: extractEmails(description),
      site: Site.EPLOY,
      atsId,
      atsType: 'eploy',
      department,
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve the tenant base URL from an explicit `companyUrl` or, when only a
   * `companySlug` is given, construct the Eploy staging sub-domain URL.
   * Returns an empty string when neither yields a valid URL.
   */
  private resolveTenantUrl(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl && companyUrl.trim()) {
      try {
        const u = new URL(companyUrl.trim());
        // Return scheme + host only (strip path/query).
        return `${u.protocol}//${u.host}`;
      } catch {
        // Fall through to slug-based resolution.
      }
    }

    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // If the slug already looks like a full hostname (contains a dot), treat
      // it as a bare host and prepend https.
      if (slug.includes('.')) {
        return `https://${slug}`;
      }
      // Plain slug (no dots) → staging sub-domain under eploy.net.
      return EPLOY_STAGING_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    }

    return '';
  }

  /**
   * Derive a human-readable company name from the tenant URL or slug, used as
   * a fallback when the `<Company>` element is empty.
   */
  private deriveCompanyName(tenantUrl: string, companySlug: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      return companySlug
        .trim()
        .replace(/[-_.]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    try {
      const u = new URL(tenantUrl);
      const host = u.host.replace(/^(www\.|jobs\.|careers\.)/, '');
      return host
        .split('.')[0]
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    } catch {
      return 'Eploy Employer';
    }
  }

  /**
   * Merge description HTML with optional benefits HTML.
   * Returns null when both are absent/empty.
   */
  private mergeDescription(
    description: string | null | undefined,
    benefits: string | null | undefined,
  ): string | null {
    const parts: string[] = [];
    if (description && description.trim()) parts.push(description.trim());
    if (benefits && benefits.trim()) parts.push(benefits.trim());
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * Extract a `LocationDto` from the free-text `<Location>` field.
   * Splits on commas to derive city, state/region, and country.
   */
  private extractLocation(item: EployVacancyItem): LocationDto | null {
    const label = item.Location?.trim();
    if (!label) return null;
    return this.locationFromLabel(label);
  }

  /** Split a free-text "City, Region, Country" label into a LocationDto. */
  private locationFromLabel(label: string): LocationDto | null {
    const parts = label
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    const state = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
    const country = parts.length >= 3 ? parts[parts.length - 1] : null;
    return new LocationDto({ city: city ?? null, state: state ?? null, country: country ?? null });
  }

  /**
   * Detect remote roles from the title, vacancy type, or location label.
   * Eploy does not have a dedicated remote flag in the datafeed.
   */
  private detectRemote(item: EployVacancyItem): boolean {
    const haystacks = [item.Title, item.Location, item.VacancyType, item.Description];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /**
   * Parse an RFC-1123 or ISO-8601 date string into a `YYYY-MM-DD` string.
   * Returns null for null/undefined inputs or unparseable strings.
   *
   * The Eploy datafeed uses RFC-1123 format:
   *   `"Wed, 03 Jun 2026 00:00:00 GMT"`
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
