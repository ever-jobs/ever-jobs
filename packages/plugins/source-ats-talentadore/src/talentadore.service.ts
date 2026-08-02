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
  TALENTADORE_ATS_HOST,
  TALENTADORE_FEED_PATH_TEMPLATE,
  TALENTADORE_FEED_QUERY,
  TALENTADORE_CAREERS_HOST_TEMPLATE,
  TALENTADORE_FEED_KEY_REGEX,
  TALENTADORE_DEFAULT_RESULTS,
  TALENTADORE_HEADERS,
} from './talentadore.constants';
import { TalentAdoreFeedResponse, TalentAdoreJob } from './talentadore.types';

/**
 * TalentAdore ATS careers scraper — generic, multi-tenant.
 *
 * TalentAdore (talentadore.com, Finland) serves every customer's open roles
 * through one shared public positions feed
 * (`GET https://ats.talentadore.com/positions/{feedKey}/json`). The feed key is
 * a feed-builder token that acts as the tenant's public read key; the feed
 * returns the full open-roles list in one envelope (`jobs[]`) — there is no
 * server-side pagination, so we fetch once and slice client-side to honour
 * `resultsWanted`.
 *
 * The caller addresses a tenant by `companySlug` or `companyUrl`. A
 * `companySlug` is normally the tenant's careers sub-domain label (e.g.
 * `amersports` → `https://amersports.careers.talentadore.com/`); the adapter
 * loads that career page and harvests the embedded
 * `ats.talentadore.com/positions/{feedKey}` reference. A caller may also pass
 * the opaque feed key directly. A single fetch error, an unknown tenant /
 * feed key (HTTP 4xx), or a malformed payload degrades to an empty result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.TALENTADORE,
  name: 'TalentAdore',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TalentAdoreService implements IScraper {
  private readonly logger = new Logger(TalentAdoreService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for TalentAdore scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a TalentAdore tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TALENTADORE_HEADERS);

    const resultsWanted = input.resultsWanted ?? TALENTADORE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      // Resolve the tenant's opaque feed key: use it verbatim if the caller
      // already passed one, else harvest it from the tenant career page.
      const feedKey = await this.resolveFeedKey(client, tenant);
      if (!feedKey) {
        this.logger.warn(`Could not resolve a TalentAdore feed key for "${tenant}"`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Fetching TalentAdore jobs for feed key: ${feedKey}`);

      // The feed returns every open role for the tenant in a single envelope.
      const envelope = await this.fetchFeed(client, feedKey);
      const companyName = this.deriveCompanyName(envelope?.company, tenant);
      const jobs = Array.isArray(envelope?.jobs) ? envelope!.jobs! : [];

      this.collect(jobs, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`TalentAdore total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`TalentAdore scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Resolve the tenant's opaque feed key.
   *
   * If the supplied tenant token already looks like a bare feed key (a short
   * URL-safe token with no separators), use it directly. Otherwise treat it as
   * a careers sub-domain label, load the tenant career page, and harvest the
   * embedded `ats.talentadore.com/positions/{feedKey}` reference.
   */
  private async resolveFeedKey(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<string | null> {
    if (this.looksLikeFeedKey(tenant)) {
      return tenant;
    }

    const careersUrl = TALENTADORE_CAREERS_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    try {
      const response = await client.get<string>(careersUrl, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      const match = html.match(TALENTADORE_FEED_KEY_REGEX);
      if (match && match[1]) return match[1];
      this.logger.warn(`No TalentAdore feed key embedded in career page for "${tenant}"`);
      return null;
    } catch (err: any) {
      // An unknown sub-domain returns HTTP 404 (or other 4xx); treat as "no jobs".
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`TalentAdore tenant "${tenant}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Fetch the tenant's positions envelope from the public feed. */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    feedKey: string,
  ): Promise<TalentAdoreFeedResponse | null> {
    const path = TALENTADORE_FEED_PATH_TEMPLATE.replace('{feedKey}', encodeURIComponent(feedKey));
    const url = `${TALENTADORE_ATS_HOST}${path}?${TALENTADORE_FEED_QUERY}`;
    try {
      const response = await client.get<TalentAdoreFeedResponse>(url);
      const data = response.data;
      if (!data || !Array.isArray(data.jobs)) {
        this.logger.warn(`TalentAdore feed "${feedKey}" returned no jobs array`);
        return null;
      }
      return data;
    } catch (err: any) {
      // An unknown / dead feed key returns HTTP 404 (or other 4xx); treat that
      // as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`TalentAdore feed "${feedKey}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: TalentAdoreJob[],
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing TalentAdore job ${job?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: TalentAdoreJob,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.name ?? job.title;
    if (!title) return null;

    const atsId = String(job.id ?? job.job_token ?? job.jobToken ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job);
    if (!jobUrl) return null;

    const rawHtml = job.description_html ?? job.descriptionHtml ?? null;
    const rawText = job.description_text ?? job.descriptionText ?? null;
    const description = this.formatDescription(rawHtml, rawText, format);

    return new JobPostDto({
      id: `talentadore-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.start_date ?? job.startDate ?? job.updated),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.TALENTADORE,
      atsId,
      atsType: 'talentadore',
      department: this.extractDepartment(job),
      employmentType: job.employment_type ?? job.employmentType ?? null,
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The feed inlines both an
   * HTML body (`description_html`) and a pre-stripped plain-text body
   * (`description_text`); we prefer HTML so markdown / plain conversion is
   * consistent, falling back to the plain-text body when HTML is absent.
   */
  private formatDescription(
    html: string | null,
    text: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (html) {
      if (format === DescriptionFormat.HTML) return html;
      if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
      return htmlToPlainText(html);
    }
    if (text) {
      // Only a plain-text body is available; surface it as-is for every format.
      return text;
    }
    return null;
  }

  /**
   * Resolve the TalentAdore tenant token from an explicit `companySlug` or from
   * a `companyUrl` (the first meaningful sub-domain label, else the trailing
   * path segment).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        // A tenant careers host is `{tenant}.careers.talentadore.com` (or a
        // custom vanity domain): the first non-`www` label is the tenant.
        const first = labels[0];
        if (first && first !== 'www') return first;
        if (labels[1]) return labels[1];
        // Fall back to the trailing path segment for embed-style URLs.
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length > 0) return segments[segments.length - 1];
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /**
   * Heuristic: a bare feed key is a short, URL-safe token (alphanumerics plus
   * `-`/`_`) with no dots or slashes. Careers sub-domain slugs are also
   * dot-free, so we additionally require the token to be short (≤ 16 chars) and
   * to contain a mix of upper- and lower-case characters, which the opaque
   * feed-builder keys do (e.g. `mwRcjSn`) but human-friendly slugs (e.g.
   * `amersports`) do not.
   */
  private looksLikeFeedKey(token: string): boolean {
    if (!/^[A-Za-z0-9_-]{5,16}$/.test(token)) return false;
    const hasUpper = /[A-Z]/.test(token);
    const hasLower = /[a-z]/.test(token);
    return hasUpper && hasLower;
  }

  /** Build the public apply / job-detail page URL from the feed's `link`. */
  private buildJobUrl(job: TalentAdoreJob): string | null {
    const link = job.link ?? job.url;
    if (typeof link === 'string' && link.trim()) {
      const trimmed = link.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      // Relative apply path — anchor it to the ATS host.
      const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      return `${TALENTADORE_ATS_HOST}${path}`;
    }
    // Last resort: reconstruct the canonical apply URL from the job token.
    const token = job.job_token ?? job.jobToken;
    if (typeof token === 'string' && token.trim()) {
      return `${TALENTADORE_ATS_HOST}/apply/${encodeURIComponent(token.trim())}`;
    }
    return null;
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * TalentAdore exposes a free-text `location` string plus structured
   * `city`/`county`/`country` parts; `county` maps to the region/state slot.
   */
  private extractLocation(job: TalentAdoreJob): LocationDto | null {
    const city = typeof job.city === 'string' && job.city.trim() ? job.city.trim() : null;
    const state = typeof job.county === 'string' && job.county.trim() ? job.county.trim() : null;
    const country =
      typeof job.country === 'string' && job.country.trim() ? job.country.trim() : null;
    if (!city && !state && !country) {
      // Fall back to the free-text location blob's leading segment as a city.
      const loc = typeof job.location === 'string' ? job.location.trim() : '';
      if (loc) return new LocationDto({ city: loc });
      return null;
    }
    return new LocationDto({ city, state, country });
  }

  /** Use the first attached category (else the owning business unit) as the department. */
  private extractDepartment(job: TalentAdoreJob): string | null {
    if (Array.isArray(job.categories)) {
      const cat = job.categories.find((c) => typeof c === 'string' && c.trim());
      if (cat) return cat.trim();
    }
    const unit = job.business_unit_name ?? job.businessUnitName;
    if (typeof unit === 'string' && unit.trim()) return unit.trim();
    return null;
  }

  /** Detect remote roles from the location text, tags, or title. */
  private detectRemote(job: TalentAdoreJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.location,
      job.city,
      job.county,
      job.name ?? job.title,
      job.employment_type ?? job.employmentType,
    ];
    if (Array.isArray(job.tags)) haystacks.push(...job.tags);
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('etätyö') ||
        v.includes('work from home') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Parse an ISO-8601 string into a YYYY-MM-DD string. */
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
}
