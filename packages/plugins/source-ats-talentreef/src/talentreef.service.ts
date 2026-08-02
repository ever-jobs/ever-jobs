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
  TALENTREEF_HOST,
  TALENTREEF_CAREERS_PATH_TEMPLATE,
  TALENTREEF_DEFAULT_LANG,
  TALENTREEF_JSONLD_REGEX,
  TALENTREEF_STATE_REGEX,
  TALENTREEF_DEFAULT_RESULTS,
  TALENTREEF_HEADERS,
} from './talentreef.constants';
import {
  TalentReefJob,
  TalentReefAddress,
  TalentReefPlace,
  TalentReefPositionsEnvelope,
} from './talentreef.types';

/**
 * TalentReef (Mitratech) ATS careers scraper — generic, multi-tenant.
 *
 * TalentReef serves every customer's open roles through one shared public
 * career-search host (`https://apply.jobappnetwork.com/{tenant}/{lang}`). The
 * tenant slug is the human-friendly path segment (e.g. `rtg`, `jibinc`). The
 * career page is a client-rendered SPA whose open roles are populated from
 * per-posting schema.org `JobPosting` JSON-LD blocks and/or an embedded
 * positions array; the full open-roles list ships in one document (the SPA
 * filters client-side), so we fetch once and slice client-side to honour
 * `resultsWanted`.
 *
 * The caller addresses a tenant by `companySlug` (the slug) or `companyUrl`
 * (a career URL whose leading path segment, or sub-domain, is the tenant). A
 * single fetch error, an unknown tenant (HTTP 4xx), or a malformed payload
 * degrades to an empty result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.TALENTREEF,
  name: 'TalentReef',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TalentReefService implements IScraper {
  private readonly logger = new Logger(TalentReefService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for TalentReef scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a TalentReef tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TALENTREEF_HEADERS);

    const resultsWanted = input.resultsWanted ?? TALENTREEF_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching TalentReef jobs for tenant: ${tenant}`);

      // The career page returns every open role for the tenant in one document.
      const html = await this.fetchCareerPage(client, tenant);
      if (html == null) {
        this.logger.warn(`TalentReef tenant "${tenant}" returned no page`);
        return new JobResponseDto([]);
      }

      const { jobs, companyName } = this.extractJobs(html, tenant);
      this.collect(jobs, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`TalentReef total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`TalentReef scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch the tenant's career-search page HTML from the public host. */
  private async fetchCareerPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<string | null> {
    const path = TALENTREEF_CAREERS_PATH_TEMPLATE.replace(
      '{tenant}',
      encodeURIComponent(tenant),
    ).replace('{lang}', TALENTREEF_DEFAULT_LANG);
    const url = `${TALENTREEF_HOST}${path}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      // An unknown tenant returns HTTP 404 (or other 4xx); treat as "no jobs".
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`TalentReef tenant "${tenant}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Extract open roles from the tenant career page HTML. Two complementary
   * public sources are harvested and merged: per-posting schema.org `JobPosting`
   * JSON-LD blocks, and any embedded SPA positions array. Both are parsed
   * defensively — a malformed block is skipped, never fatal.
   */
  private extractJobs(
    html: string,
    tenant: string,
  ): { jobs: TalentReefJob[]; companyName: string } {
    const jobs: TalentReefJob[] = [];
    let companyName: string | null = null;

    // 1) schema.org JobPosting JSON-LD blocks.
    for (const block of this.matchAll(html, TALENTREEF_JSONLD_REGEX)) {
      const parsed = this.safeJsonParse(block);
      if (parsed == null) continue;
      for (const node of this.flattenLd(parsed)) {
        if (this.isJobPosting(node)) {
          jobs.push(node as TalentReefJob);
          const org = (node as TalentReefJob).hiringOrganization;
          companyName = companyName ?? this.orgName(org);
        }
      }
    }

    // 2) Embedded SPA positions array.
    const stateMatch = html.match(TALENTREEF_STATE_REGEX);
    if (stateMatch && stateMatch[1]) {
      const env = this.safeJsonParse(stateMatch[1]) as TalentReefPositionsEnvelope | null;
      if (env) {
        const arr = this.pickArray(env);
        if (arr.length) jobs.push(...arr);
        companyName =
          companyName ??
          (typeof env.company === 'string' && env.company.trim() ? env.company.trim() : null) ??
          (typeof env.companyName === 'string' && env.companyName.trim()
            ? env.companyName.trim()
            : null) ??
          (env.client && typeof env.client.name === 'string' ? env.client.name.trim() : null);
      }
    }

    return { jobs, companyName: this.deriveCompanyName(companyName, tenant) };
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: TalentReefJob[],
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
        this.logger.warn(`Error processing TalentReef job: ${err.message}`);
      }
    }
  }

  private processJob(
    job: TalentReefJob,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title ?? job.name;
    if (!title) return null;

    const atsId = this.extractAtsId(job);
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job);
    if (!jobUrl) return null;

    const rawHtml = job.description ?? job.descriptionHtml ?? job.description_html ?? null;
    const rawText = job.descriptionText ?? job.description_text ?? null;
    const description = this.formatDescription(rawHtml, rawText, format);

    return new JobPostDto({
      id: `talentreef-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(
        job.datePosted ??
          job.datePublished ??
          job.date_posted ??
          job.postedDate ??
          job.updated,
      ),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.TALENTREEF,
      atsId,
      atsType: 'talentreef',
      department: this.extractDepartment(job),
      employmentType: this.normalizeEmploymentType(job),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. JSON-LD carries the body
   * as an HTML string under `description`; we prefer HTML so markdown / plain
   * conversion is consistent, falling back to a pre-stripped plain-text body.
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
   * Resolve the TalentReef tenant slug from an explicit `companySlug` or from a
   * `companyUrl` (the leading path segment of an `apply.jobappnetwork.com`
   * career URL, else the first meaningful sub-domain label).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // Career URLs are `apply.jobappnetwork.com/{tenant}/{lang}` — the tenant
        // is the leading path segment (skipping a `clients`/`apply` prefix).
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
          const first = segments[0].toLowerCase();
          if (first !== 'apply' && first !== 'clients' && first !== 'jobs') {
            return segments[0];
          }
          if (segments[1]) return segments[1];
        }
        // Portal-style URLs put the tenant in the sub-domain.
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        const firstLabel = labels[0];
        if (firstLabel && firstLabel !== 'www' && firstLabel !== 'apply') return firstLabel;
        if (labels[1]) return labels[1];
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /** Derive the stable ATS id from the richest available identifier field. */
  private extractAtsId(job: TalentReefJob): string {
    const candidates: Array<string | number | null | undefined> = [
      job.id,
      job.jobId,
      job.job_id,
      job.positionId,
      job.requisitionId,
    ];
    for (const c of candidates) {
      if (c != null && String(c).trim()) return String(c).trim();
    }
    // schema.org `identifier` may be a scalar or a `{ value }` object.
    const ident = job.identifier;
    if (ident != null) {
      if (typeof ident === 'object') {
        const v = (ident as { value?: string | number | null }).value;
        if (v != null && String(v).trim()) return String(v).trim();
      } else if (String(ident).trim()) {
        return String(ident).trim();
      }
    }
    // Last resort: the slug uniquely identifies a posting within a tenant.
    if (typeof job.slug === 'string' && job.slug.trim()) return job.slug.trim();
    return '';
  }

  /** Build the public apply / job-detail page URL. */
  private buildJobUrl(job: TalentReefJob): string | null {
    const direct = job.url ?? job.applyUrl ?? job.apply_url ?? job.link;
    if (typeof direct === 'string' && direct.trim()) {
      const trimmed = direct.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      return `${TALENTREEF_HOST}${path}`;
    }
    // Reconstruct from a relative path / slug when no absolute URL is present.
    const rel = job.path ?? job.slug;
    if (typeof rel === 'string' && rel.trim()) {
      const trimmed = rel.trim();
      const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      return `${TALENTREEF_HOST}${path}`;
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
   * Resolve a `LocationDto` from either a schema.org `jobLocation.address`
   * structure or a flat `city`/`state`/`country` set on an SPA item.
   */
  private extractLocation(job: TalentReefJob): LocationDto | null {
    const address = this.firstAddress(job);
    if (address) {
      const city = this.str(address.addressLocality) ?? this.str(address.name);
      const state = this.str(address.addressRegion);
      const country = this.countryName(address.addressCountry);
      if (city || state || country) return new LocationDto({ city, state, country });
    }

    // Flat SPA shape.
    const city = this.str(job.city);
    const state = this.str(job.state) ?? this.str(job.region);
    const country = this.str(job.country);
    if (city || state || country) return new LocationDto({ city, state, country });

    // Free-text location blob.
    if (typeof job.location === 'string') {
      const loc = job.location.trim();
      if (loc) return new LocationDto({ city: loc });
    }
    return null;
  }

  /** Pull the first usable address object from `jobLocation` / `location`. */
  private firstAddress(job: TalentReefJob): TalentReefAddress | null {
    const places: Array<TalentReefPlace | null> = [];
    if (Array.isArray(job.jobLocation)) places.push(...job.jobLocation);
    else if (job.jobLocation) places.push(job.jobLocation);
    for (const place of places) {
      const addr = place?.address;
      if (addr && typeof addr === 'object') return addr as TalentReefAddress;
    }
    if (job.location && typeof job.location === 'object') return job.location as TalentReefAddress;
    return null;
  }

  /** Normalize schema.org `addressCountry` (string | object) to a plain name. */
  private countryName(
    value: string | TalentReefAddress | { name?: string | null } | null | undefined,
  ): string | null {
    if (typeof value === 'string') return this.str(value);
    if (value && typeof value === 'object') {
      return this.str((value as { name?: string | null }).name);
    }
    return null;
  }

  /** Use the first category / department / industry label as the department. */
  private extractDepartment(job: TalentReefJob): string | null {
    const candidates = [job.department, job.category, job.jobCategory, job.industry, job.brand];
    for (const c of candidates) {
      const v = this.str(c);
      if (v) return v;
    }
    return null;
  }

  /** Normalize schema.org `employmentType` (string | string[]) to free text. */
  private normalizeEmploymentType(job: TalentReefJob): string | null {
    const raw = job.employmentType ?? job.employment_type;
    if (Array.isArray(raw)) {
      const first = raw.find((v) => typeof v === 'string' && v.trim());
      return first ? first.trim() : null;
    }
    return this.str(raw as string | null | undefined);
  }

  /** Detect remote roles from schema.org hints, flags, location text, or title. */
  private detectRemote(job: TalentReefJob): boolean {
    if (job.remote === true || job.isRemote === true) return true;
    if (typeof job.jobLocationType === 'string' && /telecommute|remote/i.test(job.jobLocationType)) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [
      typeof job.location === 'string' ? job.location : null,
      job.city,
      job.state,
      job.title ?? job.name,
    ];
    if (Array.isArray(job.tags)) haystacks.push(...job.tags);
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) {
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

  // --- small defensive helpers -------------------------------------------------

  /** Return all capture-group-1 matches for a global regex over a string. */
  private matchAll(html: string, regex: RegExp): string[] {
    const out: string[] = [];
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) out.push(m[1]);
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    }
    return out;
  }

  /** Parse JSON, returning null on any failure (never throws). */
  private safeJsonParse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Flatten a JSON-LD payload into candidate nodes: a single object, an array,
   * or a `@graph` container all yield their leaf objects.
   */
  private flattenLd(parsed: unknown): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const n of node) visit(n);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        out.push(obj);
        if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
      }
    };
    visit(parsed);
    return out;
  }

  /** A node is a JobPosting when its `@type` says so. */
  private isJobPosting(node: Record<string, unknown>): boolean {
    const t = node['@type'];
    if (typeof t === 'string') return /jobposting/i.test(t);
    if (Array.isArray(t)) return t.some((v) => typeof v === 'string' && /jobposting/i.test(v));
    return false;
  }

  /** Read the hiring-organization name from a JSON-LD org node or a string. */
  private orgName(org: TalentReefJob['hiringOrganization']): string | null {
    if (typeof org === 'string') return this.str(org);
    if (org && typeof org === 'object') return this.str(org.name);
    return null;
  }

  /** Pick the first populated positions array slot from an SPA envelope. */
  private pickArray(env: TalentReefPositionsEnvelope): TalentReefJob[] {
    for (const arr of [env.jobs, env.positions, env.results, env.items]) {
      if (Array.isArray(arr) && arr.length) return arr;
    }
    return [];
  }

  /** Trim a string-ish value to a non-empty string, else null. */
  private str(value: string | null | undefined): string | null {
    if (typeof value === 'string') {
      const t = value.trim();
      return t ? t : null;
    }
    return null;
  }
}
