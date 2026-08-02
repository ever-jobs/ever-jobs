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
  VIVAHR_HOST,
  VIVAHR_JOBS_PATH_TEMPLATE,
  VIVAHR_DEFAULT_RESULTS,
  VIVAHR_MAX_CONCURRENCY,
  VIVAHR_HEADERS,
} from './vivahr.constants';
import {
  VivaHRJobPosting,
  VivaHRPlace,
  VivaHRPostalAddress,
  VivaHRIdentifier,
} from './vivahr.types';

/**
 * VivaHR ATS careers scraper — generic, multi-tenant.
 *
 * VivaHR serves every customer's public careers site from one shared host
 * (`https://jobs.avahr.com/{tenant}`, where `{tenant}` is the `{id}-{slug}`
 * path token). There is no anonymous JSON API — the developer API requires a
 * per-tenant key — so the adapter scrapes the public surface: it fetches the
 * tenant's listing page to enumerate each open role's detail URL, then parses
 * the complete schema.org `JobPosting` JSON-LD embedded in every detail page.
 *
 * The tenant token is taken from `companySlug` or derived from a `companyUrl`
 * (the first `{id}-{slug}` path segment, else the first sub-domain label). A
 * single fetch error, an unknown tenant (HTTP 404 / redirect to marketing), or
 * a malformed payload degrades to an empty/partial result rather than throwing,
 * so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.VIVAHR,
  name: 'VivaHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class VivaHRService implements IScraper {
  private readonly logger = new Logger(VivaHRService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for VivaHR scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a VivaHR tenant token from input');
      return new JobResponseDto([]);
    }
    const companyName = this.deriveCompanyName(tenant);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(VIVAHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? VIVAHR_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching VivaHR jobs for tenant: ${tenant}`);

      // Step 1 — fetch the listing page and enumerate role detail URLs.
      const detailUrls = await this.fetchJobUrls(client, tenant);
      const wanted = detailUrls.slice(0, resultsWanted);

      // Step 2 — bounded concurrent fan-out over each role's JSON-LD detail page.
      for (let i = 0; i < wanted.length; i += VIVAHR_MAX_CONCURRENCY) {
        const chunk = wanted.slice(i, i + VIVAHR_MAX_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map((url) => this.fetchJobPosting(client, url)),
        );
        for (const result of settled) {
          if (result.status === 'fulfilled' && result.value) {
            this.collect(result.value, tenant, companyName, input.descriptionFormat, seen, jobPosts);
          } else if (result.status === 'rejected') {
            this.logger.warn(`VivaHR detail fetch failed: ${result.reason?.message ?? result.reason}`);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`VivaHR total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`VivaHR scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch the tenant's listing page and extract every role detail URL. */
  private async fetchJobUrls(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<string[]> {
    const url = `${VIVAHR_HOST}${VIVAHR_JOBS_PATH_TEMPLATE.replace('{tenant}', tenant)}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return this.extractJobUrls(html, tenant);
    } catch (err: any) {
      // An unknown / dead tenant 404s (or redirects to the marketing site);
      // treat that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`VivaHR tenant "${tenant}" not found (HTTP ${status})`);
        return [];
      }
      throw err;
    }
  }

  /** Parse listing HTML for anchors to `/{tenant}/{jobId}-{jobSlug}/` detail pages. */
  private extractJobUrls(html: string, tenant: string): string[] {
    if (!html) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    // Match both absolute (`https://jobs.avahr.com/{tenant}/{id}-{slug}/`) and
    // root-relative (`/{tenant}/{id}-{slug}/`) anchors on the listing page.
    const escaped = tenant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`href="((?:${VIVAHR_HOST})?/${escaped}/\\d+-[^"#?]+?/?)"`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      let href = match[1];
      if (href.startsWith('/')) href = `${VIVAHR_HOST}${href}`;
      // Skip the listing page itself; keep only `{id}-{slug}` role pages.
      if (/\/\d+-[^/]+\/?$/.test(new URL(href).pathname)) {
        const normalized = href.endsWith('/') ? href : `${href}/`;
        if (!seen.has(normalized)) {
          seen.add(normalized);
          out.push(normalized);
        }
      }
    }
    return out;
  }

  /** Fetch a single role's detail page and parse its `JobPosting` JSON-LD. */
  private async fetchJobPosting(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<VivaHRJobPosting | null> {
    const response = await client.get<string>(url, { responseType: 'text' });
    const html = typeof response.data === 'string' ? response.data : '';
    return this.parseJsonLd(html);
  }

  /** Extract the schema.org `JobPosting` object from a page's JSON-LD blocks. */
  private parseJsonLd(html: string): VivaHRJobPosting | null {
    if (!html) return null;
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const raw = match[1].trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of candidates) {
          if (c && typeof c === 'object' && c['@type'] === 'JobPosting') {
            return c as VivaHRJobPosting;
          }
        }
      } catch {
        // Malformed JSON-LD block — try the next one.
      }
    }
    return null;
  }

  /** Map a raw posting → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    posting: VivaHRJobPosting,
    tenant: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    try {
      const post = this.processJob(posting, tenant, companyName, format);
      if (!post) return;
      // processJob guarantees a non-empty atsId (returns null otherwise).
      const key = post.atsId as string;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(post);
    } catch (err: any) {
      this.logger.warn(`Error processing VivaHR job ${posting?.url}: ${err.message}`);
    }
  }

  private processJob(
    posting: VivaHRJobPosting,
    tenant: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = posting.title;
    if (!title) return null;

    const atsId = this.extractAtsId(posting);
    if (!atsId) return null;

    const jobUrl = posting.url ?? `${VIVAHR_HOST}/${tenant}/${atsId}/`;

    const rawDescription = posting.description ?? null;
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

    const org = posting.hiringOrganization;
    const resolvedCompanyName = org?.name ?? companyName;

    return new JobPostDto({
      id: `vivahr-${atsId}`,
      title,
      companyName: resolvedCompanyName,
      jobUrl,
      location: this.extractLocation(posting),
      description,
      datePosted: this.parseDate(posting.datePosted),
      isRemote: this.detectRemote(posting),
      emails: extractEmails(description),
      site: Site.VIVAHR,
      atsId,
      atsType: 'vivahr',
      department: posting.industry ?? null,
      employmentType: posting.employmentType ?? null,
      companyUrl: org?.sameAs ?? null,
      companyLogo: org?.logo ?? null,
      applyUrl: jobUrl,
    });
  }

  /** The job id lives in `identifier.value` (or a bare identifier). */
  private extractAtsId(posting: VivaHRJobPosting): string {
    const id = posting.identifier;
    if (id && typeof id === 'object') {
      const value = (id as VivaHRIdentifier).value;
      if (value != null && String(value).trim()) return String(value).trim();
    } else if (id != null && String(id).trim()) {
      return String(id).trim();
    }
    // Fallback: the leading numeric segment of the detail URL path.
    if (posting.url) {
      try {
        const segments = new URL(posting.url).pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        const m = last?.match(/^(\d+)-/);
        if (m) return m[1];
      } catch {
        // ignore
      }
    }
    return '';
  }

  /** Resolve the tenant `{id}-{slug}` token from an explicit slug or a careers URL. */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim().replace(/^\/+|\/+$/g, '');
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // VivaHR careers pages encode the tenant in the first path segment:
        // /{id}-{slug}/jobs or /{id}-{slug}/{jobId}-{jobSlug}/.
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments[0] && /^\d+-/.test(segments[0])) return segments[0];
        if (segments[0] && segments[0] !== 'jobs') return segments[0];
        // Otherwise fall back to the first sub-domain label (custom domains).
        const host = u.host.split(':')[0];
        const label = host.split('.')[0];
        if (label && label !== 'www' && label !== 'jobs') return label;
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /**
   * The tenant token is `{id}-{slug}` (e.g. "236-avahr"); strip the leading id
   * and title-case the slug into a human-readable company name fallback.
   */
  private deriveCompanyName(tenant: string): string {
    const slug = tenant.replace(/^\d+-/, '');
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Build a LocationDto from the JSON-LD `jobLocation` PostalAddress. */
  private extractLocation(posting: VivaHRJobPosting): LocationDto | null {
    const place = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
    const address = (place as VivaHRPlace | undefined)?.address as VivaHRPostalAddress | undefined;
    if (!address) return null;
    const city = address.addressLocality?.trim() || null;
    const state = address.addressRegion?.trim() || null;
    const country = address.addressCountry?.trim() || null;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from `jobLocationType` (TELECOMMUTE) or the title. */
  private detectRemote(posting: VivaHRJobPosting): boolean {
    const locType = posting.jobLocationType ?? posting.jobLocationtype;
    if (typeof locType === 'string' && locType.toUpperCase().includes('TELECOMMUTE')) return true;
    const title = posting.title;
    if (typeof title === 'string') {
      const v = title.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
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
