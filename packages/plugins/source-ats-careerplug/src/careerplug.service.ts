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
  CAREERPLUG_HOST_TEMPLATE,
  CAREERPLUG_BASE_DOMAIN,
  CAREERPLUG_JOBS_PATH,
  CAREERPLUG_LANDING_PATH,
  CAREERPLUG_JOB_DETAIL_PATH_TEMPLATE,
  CAREERPLUG_JOB_ID_REGEX,
  CAREERPLUG_SHORT_LINK_REGEX,
  CAREERPLUG_LD_JSON_SELECTOR,
  CAREERPLUG_JOB_NAME_SELECTOR,
  CAREERPLUG_JOB_LOCATION_SELECTOR,
  CAREERPLUG_DEFAULT_RESULTS,
  CAREERPLUG_HEADERS,
} from './careerplug.constants';
import {
  CareerPlugItemList,
  CareerPlugJob,
  CareerPlugJobAnchor,
  CareerPlugJobPostingLd,
  CareerPlugListItem,
  CareerPlugPlace,
  CareerPlugPostalAddress,
} from './careerplug.types';

/**
 * CareerPlug ATS careers scraper — generic, multi-tenant.
 *
 * CareerPlug (careerplug.com) is a USA-based SMB / franchise ATS. Every customer
 * tenant publishes a branded, public, anonymous careers site at
 * `https://{tenant}.careerplug.com/`. There is no anonymous JSON feed, but the
 * careers landing page and the `/jobs` index embed a complete `schema.org`
 * `ItemList` of `JobPosting` objects as `application/ld+json` — the primary,
 * stable source for this adapter. Each JSON-LD `JobPosting` carries the title,
 * full description, publish date, employment type, remote flag, region, and
 * employer; CareerPlug omits a per-item URL / id, so the adapter pairs the
 * postings (by document order) with the page's job-card anchors (`/jobs/{id}`
 * detail links, or `/j/{shortcode}` short links) to recover each role's public
 * URL and ATS id.
 *
 * Tenant resolution: `companySlug` (the sub-domain label, e.g. `cplugjobs`) is
 * preferred and expanded to `https://{tenant}.careerplug.com`; otherwise the
 * `companyUrl` origin (or its first sub-domain label) is used.
 *
 * Graceful degradation: an unknown tenant (a redirect to the CareerPlug sign-in
 * app, or an HTTP 4xx), a single fetch error, or a malformed payload degrades to
 * an empty / partial result rather than throwing, so one bad tenant never aborts
 * a batch run. De-duplication is by ATS id within the run.
 */
@SourcePlugin({
  site: Site.CAREERPLUG,
  name: 'CareerPlug',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CareerPlugService implements IScraper {
  private readonly logger = new Logger(CareerPlugService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for CareerPlug scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(input.companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a CareerPlug tenant host from input');
      return new JobResponseDto([]);
    }
    const fallbackCompanyName = this.deriveCompanyName(input.companySlug, host);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CAREERPLUG_HEADERS);

    const resultsWanted = input.resultsWanted ?? CAREERPLUG_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching CareerPlug jobs for host: ${host}`);

      // Primary: the /jobs index. Fall back to the careers landing page when the
      // index 302-redirects to a single role's application page (single-job
      // tenants) and yields no JobPosting items.
      let jobs = await this.fetchJobs(client, host, CAREERPLUG_JOBS_PATH);
      if (jobs.length === 0) {
        jobs = await this.fetchJobs(client, host, CAREERPLUG_LANDING_PATH);
      }

      this.collect(jobs, host, fallbackCompanyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`CareerPlug total: ${trimmed.length} jobs for ${host}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`CareerPlug scrape error for ${host}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch a careers page and parse its `schema.org` `ItemList` of `JobPosting`
   * objects, paired with the page's job-card anchors. Returns an empty array
   * when the tenant is unknown (HTTP 4xx, or a redirect to the sign-in app) or
   * the page carries no JobPosting JSON-LD.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    path: string,
  ): Promise<CareerPlugJob[]> {
    const url = `${host}${path}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return [];
      return this.parseJobs(html, host);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(`CareerPlug tenant not found (HTTP ${status}) for ${host}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Parse a careers-page HTML body into merged job records. Extracts the
   * `ItemList` JSON-LD postings and pairs each (by document order) with a
   * job-card anchor harvested from the same page. When the page carries no
   * `ItemList` but does carry a standalone `JobPosting` JSON-LD (a single-role
   * detail page reached via redirect), that posting is used too.
   */
  private parseJobs(html: string, host: string): CareerPlugJob[] {
    const $ = cheerio.load(html);

    const postings = this.extractPostings($);
    if (postings.length === 0) return [];

    const anchors = this.extractAnchors($, host);

    const jobs: CareerPlugJob[] = [];
    for (let i = 0; i < postings.length; i += 1) {
      jobs.push({ ld: postings[i], anchor: anchors[i] ?? null });
    }
    return jobs;
  }

  /**
   * Extract every `JobPosting` from the page's `application/ld+json` blocks.
   * Tolerates the `ItemList` wrapper, `@graph` wrappers, bare arrays, and a
   * standalone `JobPosting`. Silently skips unparseable blocks.
   */
  private extractPostings($: cheerio.CheerioAPI): CareerPlugJobPostingLd[] {
    const postings: CareerPlugJobPostingLd[] = [];

    $(CAREERPLUG_LD_JSON_SELECTOR).each((_i, el) => {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // malformed JSON-LD block — skip it
      }
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const root of roots) {
        this.collectPostingsFromNode(root, postings);
      }
    });

    return postings;
  }

  /** Recursively harvest `JobPosting` objects from a JSON-LD node. */
  private collectPostingsFromNode(node: any, out: CareerPlugJobPostingLd[]): void {
    if (!node || typeof node !== 'object') return;

    if (this.isJobPosting(node)) {
      out.push(node as CareerPlugJobPostingLd);
      return;
    }

    // ItemList → itemListElement[].item
    const list = node as CareerPlugItemList;
    if (Array.isArray(list.itemListElement)) {
      for (const entry of list.itemListElement as CareerPlugListItem[]) {
        if (entry?.item && this.isJobPosting(entry.item)) {
          out.push(entry.item);
        }
      }
      if (out.length > 0) return;
    }

    // @graph wrapper
    if (Array.isArray(node['@graph'])) {
      for (const child of node['@graph']) {
        this.collectPostingsFromNode(child, out);
      }
    }
  }

  /** True when a JSON-LD node is (or includes) a `JobPosting` `@type`. */
  private isJobPosting(node: any): boolean {
    const type = node?.['@type'];
    return Array.isArray(type) ? type.includes('JobPosting') : type === 'JobPosting';
  }

  /**
   * Harvest the page's job-card anchors in document order. CareerPlug links each
   * role via a `/jobs/{id}` detail URL or a `/j/{shortcode}` short link; both
   * yield an ATS id and an absolute public URL.
   */
  private extractAnchors($: cheerio.CheerioAPI, host: string): CareerPlugJobAnchor[] {
    const anchors: CareerPlugJobAnchor[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_i, el) => {
      const href = ($(el).attr('href') ?? '').trim();
      if (!href) return;

      const idMatch = href.match(CAREERPLUG_JOB_ID_REGEX);
      const shortMatch = href.match(CAREERPLUG_SHORT_LINK_REGEX);
      if (!idMatch && !shortMatch) return;

      const atsId = idMatch ? idMatch[1] : (shortMatch as RegExpMatchArray)[1];
      if (seen.has(atsId)) return;
      seen.add(atsId);

      const jobUrl = idMatch
        ? `${host}${CAREERPLUG_JOB_DETAIL_PATH_TEMPLATE.replace('{id}', atsId)}`
        : this.absoluteUrl(href, host);

      anchors.push({ atsId, jobUrl });
    });

    return anchors;
  }

  /** Map merged job records → JobPostDto, de-duplicating by ATS id. */
  private collect(
    jobs: CareerPlugJob[],
    host: string,
    fallbackCompanyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (let i = 0; i < jobs.length; i += 1) {
      try {
        const post = this.mapToJobPost(jobs[i], i, host, fallbackCompanyName, format);
        if (!post) continue;
        // mapToJobPost guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing CareerPlug job at index ${i}: ${err.message}`);
      }
    }
  }

  /** Map one merged record (JSON-LD posting + optional anchor) into a JobPostDto. */
  private mapToJobPost(
    job: CareerPlugJob,
    index: number,
    host: string,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const ld = job.ld;

    const title = (ld.title ?? '').trim();
    if (!title) return null;

    const atsId = this.resolveAtsId(job, title, index);
    if (!atsId) return null;

    const jobUrl = job.anchor?.jobUrl?.trim() || `${host}${CAREERPLUG_JOBS_PATH}`;

    const rawDescription = ld.description ?? null;
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

    const companyName = ld.hiringOrganization?.name?.trim() || fallbackCompanyName;

    return new JobPostDto({
      id: `careerplug-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(ld),
      description,
      datePosted: this.parseDate(ld.datePosted),
      isRemote: this.detectRemote(ld),
      emails: extractEmails(description),
      site: Site.CAREERPLUG,
      atsId,
      atsType: 'careerplug',
      employmentType: this.normaliseEmploymentType(ld.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve a stable ATS id: prefer the paired anchor's numeric id / short code;
   * otherwise derive one deterministically from the role title + list position
   * so the run still emits stable, de-dupable jobs when no anchor was present.
   */
  private resolveAtsId(job: CareerPlugJob, title: string, index: number): string {
    const fromAnchor = job.anchor?.atsId?.trim();
    if (fromAnchor) return fromAnchor;
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug ? `${slug}-${index}` : String(index);
  }

  /**
   * Build a LocationDto. On-site roles carry a structured `jobLocation.address`;
   * remote roles (`jobLocationType: TELECOMMUTE`) carry only an
   * `applicationLocationRequirement` country, which we surface as the country.
   */
  private extractLocation(ld: CareerPlugJobPostingLd): LocationDto | null {
    const address = this.firstAddress(ld.jobLocation);
    if (address) {
      const city = address.addressLocality?.trim() || null;
      const state = address.addressRegion?.trim() || null;
      const country = address.addressCountry?.trim() || null;
      if (city || state || country) {
        return new LocationDto({ city, state, country });
      }
    }

    const requirement = Array.isArray(ld.applicationLocationRequirement)
      ? ld.applicationLocationRequirement[0]
      : ld.applicationLocationRequirement;
    const country = requirement?.name?.trim();
    if (country) {
      return new LocationDto({ city: null, state: null, country });
    }

    return null;
  }

  /** Pull the first PostalAddress out of a Place or array of Places. */
  private firstAddress(
    location: CareerPlugPlace | CareerPlugPlace[] | null | undefined,
  ): CareerPlugPostalAddress | null {
    if (!location) return null;
    const place = Array.isArray(location) ? location[0] : location;
    return place?.address ?? null;
  }

  /** Detect remote roles from `jobLocationType` or the title text. */
  private detectRemote(ld: CareerPlugJobPostingLd): boolean {
    const type = (ld.jobLocationType ?? '').toUpperCase();
    if (type === 'TELECOMMUTE' || type.includes('REMOTE')) return true;
    const title = (ld.title ?? '').toLowerCase();
    return (
      title.includes('remote') ||
      title.includes('work from home') ||
      title.includes('telecommute')
    );
  }

  /** Normalise a schema.org employmentType enum key into a readable label. */
  private normaliseEmploymentType(value: string | string[] | null | undefined): string | null {
    if (!value) return null;
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw || !raw.trim()) return null;
    return (
      raw
        .trim()
        .toLowerCase()
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ') || null
    );
  }

  /**
   * Resolve the tenant careers host from `companySlug` (the sub-domain label) or
   * `companyUrl` (its origin, or first sub-domain label).
   */
  private resolveHost(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const label = companySlug.trim().toLowerCase();
      // A slug containing a dot is treated as a bare host / URL.
      if (label.includes('.') || /^https?:\/\//i.test(label)) {
        return this.originOf(label);
      }
      return CAREERPLUG_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(label));
    }
    if (companyUrl && companyUrl.trim()) {
      return this.originOf(companyUrl.trim());
    }
    return '';
  }

  /** Return the scheme+host origin of a URL string, or '' when malformed. */
  private originOf(url: string): string {
    try {
      const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      return `${u.protocol}//${u.host}`;
    } catch {
      return '';
    }
  }

  /** Resolve a possibly-relative href to an absolute URL against the host. */
  private absoluteUrl(href: string, host: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    return href.startsWith('/') ? `${host}${href}` : `${host}/${href}`;
  }

  /** Derive a display company name from the slug or host as a fallback. */
  private deriveCompanyName(companySlug: string | undefined, host: string): string {
    let base = companySlug?.trim();
    if (!base || base.includes('.') || /^https?:\/\//i.test(base)) {
      try {
        base = new URL(host).host.split('.')[0];
      } catch {
        base = host;
      }
    }
    return base
      .replace(/^https?:\/\//, '')
      .replace(new RegExp(`\\.${CAREERPLUG_BASE_DOMAIN.replace('.', '\\.')}.*$`, 'i'), '')
      .replace(/\..*$/, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Parse an ISO-8601 timestamp into a `YYYY-MM-DD` string, else null. */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value.trim());
      if (!isNaN(parsed.getTime())) return toDateOnly(value.trim());
    } catch {
      // ignore
    }
    return null;
  }
}
