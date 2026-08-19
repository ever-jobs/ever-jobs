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
  TRAFFIT_HOST_TEMPLATE,
  TRAFFIT_BASE_DOMAIN,
  TRAFFIT_PUBLISHED_PATH,
  TRAFFIT_FIELD_DESCRIPTION,
  TRAFFIT_FIELD_GEOLOCATION,
  TRAFFIT_DEFAULT_RESULTS,
  TRAFFIT_HEADERS,
} from './traffit.constants';
import {
  TraffitAdvert,
  TraffitAdvertValue,
  TraffitGeolocation,
  TraffitJobPost,
  TraffitPublishedResponse,
} from './traffit.types';

/**
 * Traffit ATS careers scraper — generic, multi-tenant.
 *
 * Traffit serves each customer's published roles through one shared public,
 * unauthenticated feed (`GET https://{tenant}.traffit.com/public/job_posts/published`).
 * The feed returns a JSON array of advert envelopes; each carries the public
 * job url/id and an `advert.values[]` array of `{ field_id, value }` entries
 * (notably `description` HTML and a structured `geolocation` object). There is
 * no server-side pagination, so we fetch once and slice client-side to honour
 * `resultsWanted`.
 *
 * The tenant is the sub-domain label, taken from `companySlug` or derived from a
 * fully-qualified `companyUrl`. A single fetch error, an unknown tenant
 * (DNS / HTTP 4xx), or a malformed payload degrades to an empty result rather
 * than throwing, so a single tenant never nukes a batch run. De-duplication is
 * by ATS id (the public job-post id) within the run.
 */
@SourcePlugin({
  site: Site.TRAFFIT,
  name: 'Traffit',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TraffitService implements IScraper {
  private readonly logger = new Logger(TraffitService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Traffit scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Traffit tenant from input');
      return new JobResponseDto([]);
    }

    const host = TRAFFIT_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const companyName = this.deriveCompanyName(tenant);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TRAFFIT_HEADERS);

    const resultsWanted = input.resultsWanted ?? TRAFFIT_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Traffit jobs for tenant: ${tenant}`);

      // The feed returns every published advert for the tenant in a single array.
      const posts = await this.fetchPublished(client, host);
      if (!posts) {
        this.logger.warn(`Traffit: no feed returned for ${tenant}`);
        return new JobResponseDto([]);
      }

      this.collect(posts, host, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Traffit total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Traffit scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch the tenant's published-adverts array from the public feed. Returns
   * null when the tenant is unknown (DNS failure or HTTP 4xx) so the caller can
   * degrade to an empty result rather than throwing.
   */
  private async fetchPublished(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<TraffitPublishedResponse | null> {
    const url = `${host}${TRAFFIT_PUBLISHED_PATH}`;
    try {
      const response = await client.get<TraffitPublishedResponse>(url);
      const data = response.data;
      if (!Array.isArray(data)) {
        this.logger.warn(`Traffit feed for ${host} returned a non-array payload`);
        return null;
      }
      return data;
    } catch (err: any) {
      // An unknown tenant sub-domain yields a DNS/connection error (no
      // `response`) or an HTTP 4xx; treat either as "no jobs" rather than a
      // hard failure so one bad tenant never breaks a batch.
      const status = err?.response?.status;
      if (status === undefined || (status >= 400 && status < 500)) {
        this.logger.warn(
          `Traffit tenant feed unavailable for ${host}` +
            (status ? ` (HTTP ${status})` : ` (${err?.code ?? err?.message ?? 'network error'})`),
        );
        return null;
      }
      throw err;
    }
  }

  /** Map raw envelopes → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    posts: TraffitJobPost[],
    host: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const post of posts) {
      try {
        const mapped = this.processJob(post, host, companyName, format);
        if (!mapped) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = mapped.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(mapped);
      } catch (err: any) {
        this.logger.warn(`Error processing Traffit job ${post?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    post: TraffitJobPost,
    host: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const advert = post.advert ?? null;

    const title = (advert?.name ?? advert?.title ?? '').trim();
    if (!title) return null;

    const atsId = String(post.id ?? '').trim();
    if (!atsId) return null;

    const jobUrl = (post.url ?? '').trim() || host;
    const applyUrl = (post.application_form ?? post.applicationForm ?? '').trim() || jobUrl;

    const rawDescription = this.extractDescription(advert);
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

    const geo = this.extractGeolocation(advert);

    return new JobPostDto({
      id: `traffit-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.buildLocation(geo),
      description,
      datePosted: this.parseDate(post.valid_start ?? post.validStart),
      isRemote: this.detectRemote(title, rawDescription, geo),
      emails: extractEmails(description),
      site: Site.TRAFFIT,
      atsId,
      atsType: 'traffit',
      department: advert?.recruitment?.nr_ref?.trim() || null,
      applyUrl,
    });
  }

  /**
   * Resolve the Traffit tenant sub-domain label from an explicit `companySlug`
   * or from a fully-qualified `companyUrl`.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim().toLowerCase();
      // A slug containing a dot is treated as a host — extract its first label.
      if (slug.includes('.') || /^https?:\/\//i.test(slug)) {
        return this.firstSubdomainLabel(slug);
      }
      return slug;
    }
    if (companyUrl && companyUrl.trim()) {
      return this.firstSubdomainLabel(companyUrl.trim());
    }
    return '';
  }

  /**
   * Extract the first meaningful sub-domain label from a URL or bare host,
   * skipping a leading `www` and guarding against the bare apex domain.
   */
  private firstSubdomainLabel(value: string): string {
    try {
      const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      const host = u.host.split(':')[0].toLowerCase();
      const labels = host.split('.').filter(Boolean);
      // Strip a leading "www" so "www.acme.traffit.com" → "acme".
      if (labels[0] === 'www') labels.shift();
      const first = labels[0];
      // A bare apex (e.g. "traffit.com") has no tenant label.
      if (!first || `${first}.${labels.slice(1).join('.')}` === TRAFFIT_BASE_DOMAIN) {
        return '';
      }
      return first;
    } catch {
      return '';
    }
  }

  /** Pull the description HTML out of the advert's `values[]` field entries. */
  private extractDescription(advert: TraffitAdvert | null): string | null {
    const raw = this.fieldValue(advert, TRAFFIT_FIELD_DESCRIPTION);
    if (typeof raw === 'string' && raw.trim()) return raw;
    return null;
  }

  /** Pull the structured geolocation object out of the advert's `values[]`. */
  private extractGeolocation(advert: TraffitAdvert | null): TraffitGeolocation | null {
    const raw = this.fieldValue(advert, TRAFFIT_FIELD_GEOLOCATION);
    if (raw && typeof raw === 'object') return raw as TraffitGeolocation;
    return null;
  }

  /** Find the first `advert.values[]` entry matching `fieldId` and return its value. */
  private fieldValue(
    advert: TraffitAdvert | null,
    fieldId: string,
  ): string | TraffitGeolocation | Record<string, unknown> | null {
    const values = Array.isArray(advert?.values) ? advert!.values! : [];
    for (const entry of values as TraffitAdvertValue[]) {
      const id = entry?.field_id ?? entry?.fieldId;
      if (id === fieldId) return entry.value ?? null;
    }
    return null;
  }

  /** Build a LocationDto from the structured geolocation object. */
  private buildLocation(geo: TraffitGeolocation | null): LocationDto | null {
    if (!geo) return null;
    const city =
      typeof geo.locality === 'string' && geo.locality.trim() ? geo.locality.trim() : null;
    const state =
      typeof geo.region1 === 'string' && geo.region1.trim() ? geo.region1.trim() : null;
    const country =
      typeof geo.country === 'string' && geo.country.trim()
        ? geo.country.trim()
        : typeof geo.iso === 'string' && geo.iso.trim()
          ? geo.iso.trim().toUpperCase()
          : null;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Derive a display company name from the tenant sub-domain label. */
  private deriveCompanyName(tenant: string): string {
    return tenant
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Detect remote roles from the title, description text, or geolocation. */
  private detectRemote(
    title: string,
    description: string | null,
    geo: TraffitGeolocation | null,
  ): boolean {
    const haystacks = [title, description ?? '', geo?.locality ?? ''];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('zdalna') || // Polish: remote
        v.includes('praca zdalna') ||
        v.includes('work from home') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse the feed's `valid_start` timestamp ("YYYY-MM-DD HH:MM:SS") or any ISO
   * date string into a `YYYY-MM-DD` string. Returns null for null/undefined or
   * unparseable inputs.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      // "2026-06-03 15:58:21" → ISO-compatible "2026-06-03T15:58:21".
      const normalised = value.trim().replace(' ', 'T');
      const parsed = new Date(normalised);
      if (!isNaN(parsed.getTime())) return toDateOnly(normalised);
    } catch {
      // ignore
    }
    return null;
  }
}
