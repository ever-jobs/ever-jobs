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
  ZOHORECRUIT_HOST_TEMPLATE,
  ZOHORECRUIT_CAREERS_PATH,
  ZOHORECRUIT_JOBS_INPUT_ID,
  ZOHORECRUIT_JOB_URL_TEMPLATE,
  ZOHORECRUIT_HEADERS,
} from './zohorecruit.constants';
import { ZohoRecruitJobOpening } from './zohorecruit.types';

/**
 * Zoho Recruit career-site scraper — generic, multi-tenant.
 *
 * Resolves a tenant from `companySlug` (→ `https://{slug}.zohorecruit.com`) or
 * an explicit `companyUrl` (custom domain / non-US datacenter), then fetches the
 * public `/jobs/Careers` page. Zoho server-renders the full open-roles list as
 * an HTML-entity-encoded JSON array inside a hidden `<input id="jobs">` element,
 * so no authentication and no API pagination are required — we parse that array
 * directly. Each opening is mapped into the standard `JobPostDto` contract.
 */
@SourcePlugin({
  site: Site.ZOHORECRUIT,
  name: 'ZohoRecruit',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ZohoRecruitService implements IScraper {
  private readonly logger = new Logger(ZohoRecruitService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Zoho Recruit scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    const urlSlug = this.resolveUrlSlug(companySlug, host);
    const companyName = this.deriveCompanyName(companySlug, host);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ZOHORECRUIT_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      const url = `${host}${ZOHORECRUIT_CAREERS_PATH}`;
      this.logger.log(`Fetching Zoho Recruit careers for tenant: ${host}`);

      // The careers page is a single server-rendered document; wrap the fetch in
      // `Promise.allSettled` so a transient failure degrades to partial results
      // (empty) rather than aborting an enclosing batch.
      const [settled] = await Promise.allSettled([this.fetchOpenings(client, url)]);
      if (settled.status === 'rejected') {
        this.logger.warn(
          `Zoho Recruit careers fetch failed for ${host}: ${settled.reason?.message ?? settled.reason}`,
        );
        return new JobResponseDto([]);
      }

      this.collect(settled.value, urlSlug, companyName, host, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Zoho Recruit total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Zoho Recruit scrape error for ${host}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch the careers page and extract the embedded `jobs` openings array. */
  private async fetchOpenings(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<ZohoRecruitJobOpening[]> {
    const response = await client.get<string>(url);
    const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    return this.parseOpenings(html);
  }

  /**
   * Extract and decode the hidden `<input id="jobs" value="[...]">` payload.
   * The value attribute is HTML-entity-encoded JSON; we locate the input,
   * pull its value, decode entities, and JSON.parse defensively.
   */
  private parseOpenings(html: string): ZohoRecruitJobOpening[] {
    if (!html) return [];
    // Match the hidden input with id="jobs"; the value attribute may appear
    // before or after the id attribute, so try both orderings.
    const patterns = [
      new RegExp(`<input[^>]*\\bid=["']${ZOHORECRUIT_JOBS_INPUT_ID}["'][^>]*\\bvalue=["']([\\s\\S]*?)["']`, 'i'),
      new RegExp(`<input[^>]*\\bvalue=["']([\\s\\S]*?)["'][^>]*\\bid=["']${ZOHORECRUIT_JOBS_INPUT_ID}["']`, 'i'),
    ];
    let raw: string | null = null;
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match && match[1] != null) {
        raw = match[1];
        break;
      }
    }
    if (raw == null) return [];

    const decoded = this.decodeHtmlEntities(raw);
    try {
      const parsed = JSON.parse(decoded);
      return Array.isArray(parsed) ? (parsed as ZohoRecruitJobOpening[]) : [];
    } catch {
      return [];
    }
  }

  /** Decode the minimal set of HTML entities Zoho emits in the value attribute. */
  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /** Map raw openings → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    openings: ZohoRecruitJobOpening[],
    urlSlug: string,
    companyName: string,
    host: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const opening of openings) {
      try {
        const post = this.processJob(opening, urlSlug, companyName, host, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Zoho Recruit opening ${opening?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    opening: ZohoRecruitJobOpening,
    urlSlug: string,
    companyName: string,
    host: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    // Skip draft/locked records, and skip records explicitly unpublished from
    // the public career site (only when the flag is present and false).
    if (opening.Is_Locked === true) return null;
    if (opening.Publish === false) return null;

    const title = opening.Posting_Title ?? opening.Job_Opening_Name;
    if (!title) return null;

    const atsId = String(opening.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(host, atsId, title, urlSlug);

    const rawDescription = opening.Job_Description ?? null;
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

    const department = opening.Industry ?? null;

    return new JobPostDto({
      id: `zohorecruit-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(opening),
      description,
      datePosted: this.parseDate(opening.Date_Opened),
      isRemote: this.detectRemote(opening),
      emails: extractEmails(description),
      site: Site.ZOHORECRUIT,
      atsId,
      atsType: 'zohorecruit',
      department,
      employmentType: opening.Job_Type ?? null,
      applyUrl: jobUrl,
    });
  }

  /** Resolve the tenant host from an explicit URL or the slug subdomain. */
  private resolveHost(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        return `${u.protocol}//${u.host}`;
      } catch {
        // Fall through to slug-based host if the URL is malformed.
      }
    }
    return ZOHORECRUIT_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(companySlug ?? ''));
  }

  /**
   * The slug used as the trailing (cosmetic) segment of the job-detail URL.
   * Prefer the explicit `companySlug`; otherwise derive it from the host's
   * leading subdomain label.
   */
  private resolveUrlSlug(companySlug: string | undefined, host: string): string {
    if (companySlug) return companySlug;
    try {
      return new URL(host).host.split('.')[0] || 'careers';
    } catch {
      return 'careers';
    }
  }

  private deriveCompanyName(companySlug: string | undefined, host: string): string {
    let base = companySlug;
    if (!base) {
      try {
        base = new URL(host).host.split('.')[0];
      } catch {
        base = host;
      }
    }
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Build the public job-detail URL: `{host}/jobs/Careers/{id}/{slug}`. */
  private buildJobUrl(host: string, atsId: string, title: string, urlSlug: string): string {
    const titleSlug = this.slugify(title) || urlSlug;
    return ZOHORECRUIT_JOB_URL_TEMPLATE.replace('{host}', host)
      .replace('{id}', encodeURIComponent(atsId))
      .replace('{slug}', titleSlug);
  }

  /** Lowercase, hyphenate, strip non-url-safe characters. */
  private slugify(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** Build a LocationDto from the City/State/Country fields, or null if all empty. */
  private extractLocation(opening: ZohoRecruitJobOpening): LocationDto | null {
    const city = this.clean(opening.City);
    const state = this.clean(opening.State);
    const country = this.clean(opening.Country);
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  private clean(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Detect remote roles from the boolean `Remote_Job` flag (string-tolerant). */
  private detectRemote(opening: ZohoRecruitJobOpening): boolean {
    const flag = opening.Remote_Job;
    if (typeof flag === 'boolean') return flag;
    if (typeof flag === 'string') {
      const v = (flag as string).toLowerCase();
      return v === 'true' || v === 'yes' || v.includes('remote');
    }
    return false;
  }

  /** Parse epoch-seconds, epoch-ms, or ISO strings into a YYYY-MM-DD string. */
  private parseDate(value: string | number | null | undefined): string | null {
    if (value == null) return null;
    try {
      if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value > 1e10 ? value : value * 1000;
        return toDateOnly(ms);
      }
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
