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
  DVINCI_HOST_SUFFIX,
  DVINCI_HOST_TEMPLATE,
  DVINCI_LIST_PATH,
  DVINCI_DEFAULT_LANG,
  DVINCI_DEFAULT_RESULTS,
  DVINCI_HEADERS,
} from './dvinci.constants';
import {
  DvinciAddress,
  DvinciCountry,
  DvinciJobOpening,
  DvinciJobPublication,
  DvinciListResponse,
  DvinciLocation,
  DvinciNamedRef,
} from './dvinci.types';

/**
 * d.vinci ATS careers scraper — generic, multi-tenant.
 *
 * d.vinci serves each customer's open roles through the vendor's documented,
 * public Job Publication REST API
 * (`GET https://{slug}.dvinci-hr.com/jobPublication/list.json`). The endpoint is
 * "always public" (no auth, API key, or cookie) and returns the tenant's full
 * array of active publications in one response — there is no server-side
 * pagination, so we fetch once and slice client-side to honour `resultsWanted`.
 *
 * The tenant slug is taken from `companySlug` or derived from `companyUrl`
 * (the first sub-domain label of a `*.dvinci-hr.com` host, else the host's first
 * label). A single fetch error, an unknown tenant (HTTP 4xx — the sub-domain
 * does not resolve to a live portal, or the interface is disabled), or a
 * malformed payload degrades to an empty result rather than throwing, so a
 * single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.DVINCI,
  name: 'd.vinci',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class DvinciService implements IScraper {
  private readonly logger = new Logger(DvinciService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for d.vinci scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a d.vinci tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DVINCI_HEADERS);

    const resultsWanted = input.resultsWanted ?? DVINCI_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching d.vinci jobs for tenant: ${slug}`);

      // The endpoint returns every active publication for the tenant at once.
      const publications = await this.fetchPublications(client, slug);
      const companyName = this.deriveCompanyName(slug);

      this.collect(publications, slug, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`d.vinci total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`d.vinci scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch the tenant's active job publications from the public list endpoint. */
  private async fetchPublications(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<DvinciJobPublication[]> {
    const origin = DVINCI_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    const url = `${origin}${DVINCI_LIST_PATH}?lang=${encodeURIComponent(DVINCI_DEFAULT_LANG)}`;
    try {
      const response = await client.get<DvinciListResponse>(url);
      return this.normalizeList(response.data);
    } catch (err: any) {
      // An unknown tenant (sub-domain not a live portal) or a portal with the
      // interface disabled returns HTTP 403/404 (occasionally 400/422); treat
      // that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404 || status === 422) {
        this.logger.warn(`d.vinci tenant "${slug}" not available (HTTP ${status})`);
        return [];
      }
      throw err;
    }
  }

  /** Normalise the list payload — a bare array or an enveloped variant. */
  private normalizeList(data: DvinciListResponse | null | undefined): DvinciJobPublication[] {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const env = data as { jobPublications?: unknown; data?: unknown };
      if (Array.isArray(env.jobPublications)) return env.jobPublications as DvinciJobPublication[];
      if (Array.isArray(env.data)) return env.data as DvinciJobPublication[];
    }
    return [];
  }

  /** Map raw publications → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    publications: DvinciJobPublication[],
    slug: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const pub of publications) {
      try {
        const post = this.processJob(pub, slug, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing d.vinci publication ${pub?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    pub: DvinciJobPublication,
    slug: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = this.pickString(pub.position) ?? this.pickString(pub.pageTitle);
    if (!title) return null;

    const atsId = String(pub.id ?? pub.jobOpening?.id ?? '');
    if (!atsId) return null;

    const origin = DVINCI_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    const jobUrl = this.pickString(pub.jobPublicationURL) ?? `${origin}/en/jobs/${atsId}`;
    const applyUrl = this.pickString(pub.applicationFormURL) ?? `${jobUrl}/apply`;

    const opening = pub.jobOpening ?? null;
    const description = this.buildDescription(pub, format);

    return new JobPostDto({
      id: `dvinci-${atsId}`,
      title,
      companyName,
      jobUrl,
      jobUrlDirect: jobUrl,
      location: this.extractLocation(opening),
      description,
      datePosted: this.parseDate(pub.startDate ?? opening?.createdDate),
      isRemote: this.detectRemote(pub, opening),
      emails: extractEmails(description),
      site: Site.DVINCI,
      atsId,
      atsType: 'dvinci',
      department: this.extractDepartment(opening),
      employmentType: this.extractEmploymentType(opening),
      applyUrl,
    });
  }

  /**
   * Resolve the d.vinci tenant slug from an explicit `companySlug` or from a
   * `companyUrl` (the first sub-domain label of a `*.dvinci-hr.com` host, else
   * the first host label, skipping a leading `www`).
   */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const trimmed = companySlug.trim();
      // A slug given as a full host (e.g. "inverto.dvinci-hr.com") → first label.
      if (trimmed.includes('.')) {
        const label = trimmed.split('.')[0];
        if (label && label !== 'www') return label;
      }
      return trimmed;
    }
    if (companyUrl) {
      try {
        const u = new URL(this.ensureProtocol(companyUrl));
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        // Prefer the label preceding the shared `dvinci-hr.com` suffix.
        if (host.endsWith(DVINCI_HOST_SUFFIX) && labels.length >= 3) {
          const first = labels[0];
          if (first && first !== 'www') return first;
        }
        const first = labels[0];
        if (first && first !== 'www') return first;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Prepend `https://` when a bare host/URL is supplied without a scheme. */
  private ensureProtocol(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }

  /**
   * Build the description from the publication's HTML content sections
   * (introduction → tasks → profile → weOffer → closingText), converted per the
   * requested format.
   */
  private buildDescription(
    pub: DvinciJobPublication,
    format?: DescriptionFormat,
  ): string | null {
    const sections = [pub.introduction, pub.tasks, pub.profile, pub.weOffer, pub.closingText]
      .map((s) => this.pickString(s))
      .filter((s): s is string => !!s);
    if (sections.length === 0) {
      // Fall back to the short page description when no rich sections are present.
      const fallback = this.pickString(pub.pageDescription);
      if (!fallback) return null;
      return this.convert(fallback, format);
    }
    const html = sections.join('\n');
    return this.convert(html, format);
  }

  /** Convert an HTML body to the requested description format. */
  private convert(html: string, format?: DescriptionFormat): string {
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  private deriveCompanyName(slug: string): string {
    // The list payload carries no explicit employer name field across tenants,
    // so derive a readable name from the tenant slug.
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Extract a structured location from the opening. Prefers the structured
   * `locations[]` entry (city/state/country); falls back to the free-text
   * `location` label.
   */
  private extractLocation(opening: DvinciJobOpening | null): LocationDto | null {
    if (!opening) return null;

    const structured = Array.isArray(opening.locations) ? opening.locations[0] : null;
    if (structured) {
      const loc = this.fromStructured(structured);
      if (loc) return loc;
    }

    const label = this.pickString(opening.location);
    if (label) return new LocationDto({ city: label });

    return null;
  }

  /** Build a LocationDto from a structured `jobOpening.locations[]` entry. */
  private fromStructured(entry: DvinciLocation): LocationDto | null {
    const address: DvinciAddress | null = entry.address ?? null;
    const city =
      this.pickString(address?.city) ?? this.pickString(entry.name) ?? null;
    const state = this.pickString(address?.usState) ?? null;
    const country =
      this.countryName(entry.country) ?? this.countryName(address?.country) ?? null;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Resolve a country display name from a structured ref or a plain string. */
  private countryName(country: DvinciCountry | string | null | undefined): string | null {
    if (typeof country === 'string') return this.pickString(country);
    if (country && typeof country === 'object') return this.pickString(country.name);
    return null;
  }

  /** Department display name from the opening, when present. */
  private extractDepartment(opening: DvinciJobOpening | null): string | null {
    if (!opening) return null;
    const dept = this.pickString(opening.department);
    if (dept) return dept;
    // Fall back to the first category name, which acts as a function tag.
    const cat = Array.isArray(opening.categories) ? opening.categories[0] : null;
    return this.pickString(cat?.name);
  }

  /** Employment type from the opening's working-time labels. */
  private extractEmploymentType(opening: DvinciJobOpening | null): string | null {
    if (!opening) return null;
    const times = Array.isArray(opening.workingTimes) ? opening.workingTimes : [];
    const labels = times
      .map((t) => this.refName(t))
      .filter((s): s is string => !!s);
    if (labels.length > 0) return labels.join(', ');
    return this.refName(opening.contractPeriod);
  }

  /** Resolve a display name from a `{ name }` ref or a plain string. */
  private refName(ref: DvinciNamedRef | string | null | undefined): string | null {
    if (typeof ref === 'string') return this.pickString(ref);
    if (ref && typeof ref === 'object') return this.pickString(ref.name);
    return null;
  }

  /** Detect remote roles from the free-text location label or the title. */
  private detectRemote(pub: DvinciJobPublication, opening: DvinciJobOpening | null): boolean {
    const haystacks = [opening?.location, pub.position, pub.pageTitle];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('work from home') ||
        v.includes('wfh') ||
        v.includes('homeoffice') ||
        v.includes('home office') ||
        v.includes('telework') ||
        v.includes('telearbeit')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Trim a value to a non-empty string, or return null. */
  private pickString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  /** Parse an ISO-8601 timestamp into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null) return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
