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
  WTTJ_ROOT_DOMAIN,
  WTTJ_ALGOLIA_INDEXES,
  WTTJ_DEFAULT_LANG,
  WTTJ_PAGE_SIZE,
  WTTJ_MAX_PAGES,
  WTTJ_DEFAULT_RESULTS,
  WTTJ_DEFAULT_TIMEOUT_SECONDS,
  WTTJ_HEADERS,
  WTTJ_REMOTE_REGEX,
  wttjAlgoliaQueryUrl,
  wttjCompanyJobsUrl,
} from './wttj.constants';
import {
  WttjAlgoliaResponse,
  WttjJob,
  WttjJobHit,
  WttjOffice,
} from './wttj.types';

/**
 * Welcome to the Jungle (WTTJ) ATS careers scraper — generic, multi-tenant.
 *
 * Welcome to the Jungle (welcometothejungle.com, France / EU) is a recruitment and
 * employer-branding marketplace. Each company ("organization") publishes a branded,
 * public, unauthenticated jobs page on the shared host
 * `https://www.welcometothejungle.com/{lang}/companies/{slug}/jobs`. The candidate-facing
 * front-end is powered by a **public, anonymous Algolia search index** whose search-only
 * credentials are embedded in the WTTJ front-end JavaScript. Rather than scraping the
 * server-rendered HTML or driving a headless browser, the adapter queries that index
 * directly:
 *
 *   POST https://{appId}-dsn.algolia.net/1/indexes/{index}/query
 *     headers: x-algolia-application-id, x-algolia-api-key, Referer (allow-listed)
 *     body:    { query: '', hitsPerPage, page, facetFilters: [["organization.slug:{slug}"]] }
 *
 * and maps each returned hit. Each hit's `reference` (a stable per-role guid, equal to
 * `objectID`) is the ATS id, and its `slug` + the embedded `organization.slug` build the
 * canonical detail URL `/{lang}/companies/{org.slug}/jobs/{job.slug}` and apply URL
 * (the same path with `/apply` appended).
 *
 * The caller addresses a company by `companySlug` (e.g. `groupe-partnaire`) or by
 * `companyUrl` (a WTTJ company-jobs URL whose `/companies/{slug}` segment encodes the
 * slug). An unknown company, one with no open roles, or an empty index response degrades
 * naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed
 * body degrades to an empty / partial result rather than throwing, so a single company
 * never nukes a batch run.
 */
@SourcePlugin({
  site: Site.WTTJ,
  name: 'Welcome to the Jungle',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class WelcomeToTheJungleService implements IScraper {
  private readonly logger = new Logger(WelcomeToTheJungleService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for WelcomeToTheJungle scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a WelcomeToTheJungle company slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Algolia DSN degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path
    // keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? WTTJ_DEFAULT_TIMEOUT_SECONDS,
      WTTJ_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(WTTJ_HEADERS);

    const resultsWanted = input.resultsWanted ?? WTTJ_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching WelcomeToTheJungle jobs for company: ${slug}`);

      const hits = await this.fetchHits(client, slug, resultsWanted);
      if (hits.length === 0) {
        this.logger.log(`WelcomeToTheJungle company "${slug}" has no reachable open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const hit of hits) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processHit(hit, slug, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing WelcomeToTheJungle role ${hit?.reference ?? hit?.objectID}: ${err.message}`,
          );
        }
      }

      this.logger.log(`WelcomeToTheJungle total: ${jobPosts.length} jobs for ${slug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`WelcomeToTheJungle scrape error for ${slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Query the public Algolia job index for the company, walking pages until
   * `resultsWanted` is satisfied or the pages are exhausted. The localised indexes are
   * tried in order; the first index that yields any hits for the company wins. An unknown
   * company, a disabled / missing index (HTTP 4xx), or a network failure degrades to an
   * empty list (never throws).
   */
  private async fetchHits(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    resultsWanted: number,
  ): Promise<WttjJobHit[]> {
    for (const index of WTTJ_ALGOLIA_INDEXES) {
      const items: WttjJobHit[] = [];
      const seen = new Set<string>();
      // Bound the page walk: by resultsWanted, by the configured page cap, and (once the
      // first page reports nbPages) by the company's actual page count.
      let totalPages = WTTJ_MAX_PAGES;

      for (let page = 0; page < Math.min(totalPages, WTTJ_MAX_PAGES); page++) {
        const response = await this.queryIndex(client, index, slug, page);
        // A transport-level failure (DNS / refused / reset / timeout) means the Algolia
        // DSN itself is unreachable — no other page/index can succeed, so abort.
        if (response === null) return items;

        if (typeof response.nbPages === 'number' && response.nbPages > 0) {
          totalPages = response.nbPages;
        }

        const hits = Array.isArray(response.hits) ? response.hits : [];
        let added = 0;
        for (const hit of hits) {
          const key = this.deriveAtsId(hit);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          items.push(hit);
          added++;
          if (items.length >= resultsWanted) return items;
        }

        // Stop the page walk once a page yields no new hits (empty / exhausted board).
        if (added === 0) break;
      }

      if (items.length > 0) {
        this.logger.log(`WelcomeToTheJungle index ${index} yielded ${items.length} jobs for ${slug}`);
        return items;
      }
    }

    return [];
  }

  /**
   * POST one Algolia query page for the company. Returns the parsed response, or `null`
   * for a transport-level failure (the caller stops walking). An HTTP error status
   * (4xx / 5xx — a reachable host) is surfaced as an empty-but-defined response so the
   * caller treats it as "no roles on this index" and moves on. Never throws.
   */
  private async queryIndex(
    client: ReturnType<typeof createHttpClient>,
    index: string,
    slug: string,
    page: number,
  ): Promise<WttjAlgoliaResponse | null> {
    const url = wttjAlgoliaQueryUrl(index);
    const body = {
      query: '',
      hitsPerPage: WTTJ_PAGE_SIZE,
      page,
      // Restrict to the company's roles; the embedded organization slug is the facet key.
      facetFilters: [[`organization.slug:${slug}`]],
    };

    try {
      const response = await client.post<WttjAlgoliaResponse>(url, body);
      const data = response?.data;
      if (data && typeof data === 'object') return data as WttjAlgoliaResponse;
      // A 200 with a non-object / empty body is treated as "no roles" (reachable host).
      return { hits: [] };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, so this is a
        // "no roles on this index" result rather than a host-down signal.
        this.logger.warn(`WelcomeToTheJungle index ${index} returned HTTP ${status} for ${slug}`);
        return { hits: [] };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the Algolia DSN is unreachable. Degrade gracefully and signal host-down (null).
      this.logger.warn(`WelcomeToTheJungle query failed for ${slug}: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Map a parsed Algolia hit → JobPostDto, deduping by ATS id. */
  private processHit(
    hit: WttjJobHit,
    slug: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseHit(hit, slug);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, slug, format);
  }

  /** Build a normalised WttjJob from a parsed Algolia hit. */
  private normaliseHit(hit: WttjJobHit, slug: string): WttjJob | null {
    const atsId = this.deriveAtsId(hit);
    if (!atsId) return null;

    // Prefer the embedded organization slug for URL building; fall back to the requested
    // slug so a canonical URL is always producible.
    const orgSlug = this.cleanText(hit.organization?.slug) ?? slug;
    const lang = this.cleanText(hit.language) ?? WTTJ_DEFAULT_LANG;
    const jobSlug = this.cleanText(hit.slug);

    const url = this.buildDetailUrl(lang, orgSlug, jobSlug);
    const applyUrl = this.buildApplyUrl(lang, orgSlug, jobSlug);

    const office = this.pickOffice(hit.offices);
    const department = this.deriveDepartment(hit);

    return {
      atsId,
      url,
      applyUrl,
      title: this.cleanText(hit.name),
      companyName: this.cleanText(hit.organization?.name) ?? this.deriveCompanyName(orgSlug),
      city: this.cleanText(office?.city),
      state: this.cleanText(office?.state),
      country: this.cleanText(office?.country),
      descriptionHtml: this.assembleDescription(hit),
      department,
      employmentType: this.normaliseContractType(hit.contract_type),
      datePosted: this.parseDate(hit.published_at) ?? this.parseDate(hit.published_at_date),
      isRemote: this.detectRemote(hit),
    };
  }

  /** Map a normalised WttjJob → JobPostDto. */
  private processJob(
    job: WttjJob,
    slug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(slug);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `wttj-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.WTTJ,
      atsId,
      atsType: 'wttj',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Derive the stable ATS id from a hit: prefer the `reference` guid, then the
   * equivalent `objectID`. Returns null when neither is usable.
   */
  private deriveAtsId(hit: WttjJobHit): string | null {
    return this.cleanText(hit.reference) ?? this.cleanText(hit.objectID);
  }

  /**
   * Assemble the richest available job-ad body from the hit's section fragments. WTTJ
   * splits the ad into `key_missions`, `profile`, and a `summary` teaser; we concatenate
   * the present fragments (mission + profile, falling back to the summary) so the
   * description is as complete as the index exposes.
   */
  private assembleDescription(hit: WttjJobHit): string | null {
    const parts = [hit.key_missions, hit.profile]
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length > 0) return parts.join('\n\n');
    return this.cleanText(hit.summary);
  }

  /** Pick the first usable office from a hit's offices array. */
  private pickOffice(offices: WttjOffice[] | null | undefined): WttjOffice | null {
    if (!Array.isArray(offices) || offices.length === 0) return null;
    const withCity = offices.find((o) => this.cleanText(o?.city));
    return withCity ?? offices[0] ?? null;
  }

  /**
   * Derive a department / profession label from the hit's profession classification,
   * preferring the sub-category, then the category, then the pivot label.
   */
  private deriveDepartment(hit: WttjJobHit): string | null {
    const prof = hit.new_profession;
    if (!prof) return null;
    return (
      this.cleanText(prof.sub_category_name) ??
      this.cleanText(prof.category_name) ??
      this.cleanText(prof.pivot_name)
    );
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The body fragments are HTML-ish, so
   * HTML returns them as-is, Markdown converts them, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the company slug. An explicit `companySlug` is used directly (a bare
   * company-jobs URL passed as the slug is reduced to its `/companies/{slug}` token); a
   * `companyUrl` on a `welcometothejungle.com` host has the slug taken from its
   * `/companies/{slug}` path segment. Returns an empty string when neither yields a slug.
   */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full company-jobs URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(WTTJ_ROOT_DOMAIN)) {
        const fromUrl = this.slugFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.slugFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the company slug from a WTTJ URL. Company pages live at
   * `welcometothejungle.com/{lang}/companies/{slug}/…`; the slug is the path segment
   * immediately after `companies`.
   */
  private slugFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(WTTJ_ROOT_DOMAIN)) {
        // Not a WTTJ host — no derivable slug.
        return '';
      }
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const idx = segments.findIndex((s) => s.toLowerCase() === 'companies');
      if (idx >= 0 && segments[idx + 1]) {
        return decodeURIComponent(segments[idx + 1]).toLowerCase();
      }
    } catch {
      // Malformed URL — no slug.
    }
    return '';
  }

  /** Build the canonical public detail URL for a role. */
  private buildDetailUrl(lang: string, orgSlug: string, jobSlug: string | null): string {
    const base = wttjCompanyJobsUrl(lang, orgSlug);
    return jobSlug ? `${base}/${encodeURIComponent(jobSlug)}` : base;
  }

  /** Build the canonical public apply URL for a role (detail URL + `/apply`). */
  private buildApplyUrl(lang: string, orgSlug: string, jobSlug: string | null): string {
    const detail = this.buildDetailUrl(lang, orgSlug, jobSlug);
    return jobSlug ? `${detail}/apply` : detail;
  }

  /** De-slugify + title-case the company slug into a display name (fallback only). */
  private deriveCompanyName(slug: string): string {
    const base = slug && slug.trim() ? slug.trim() : slug;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: WttjJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the hit's remote token, title, offices, and profession text. */
  private detectRemote(hit: WttjJobHit): boolean {
    const remoteToken = this.cleanText(hit.remote);
    // The structured `remote` token is the authoritative signal: any value other than a
    // bare "no" / "none" / "false" marks the role as remote-capable.
    if (remoteToken && !/^(no|none|false|onsite|on[\s-]?site)$/i.test(remoteToken)) {
      return true;
    }

    const office = this.pickOffice(hit.offices);
    const haystacks: Array<string | null | undefined> = [
      this.cleanText(hit.name),
      this.cleanText(office?.city),
      this.cleanText(office?.state),
      this.deriveDepartment(hit),
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (WTTJ_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Normalise a WTTJ `contract_type` token (e.g. `full_time`, `part_time`,
   * `internship`, `apprenticeship`, `vie`) into a readable, trimmed, title-cased label.
   */
  private normaliseContractType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable
   * values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    try {
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
