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
  parseLocationText,
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  EIGHTFOLD_HOST_TEMPLATE,
  EIGHTFOLD_JOBS_PATH,
  EIGHTFOLD_PCSX_SEARCH_PATH,
  EIGHTFOLD_PAGE_SIZE,
  EIGHTFOLD_MAX_CONCURRENCY,
  EIGHTFOLD_REQUEST_DELAY_MS,
  EIGHTFOLD_HEADERS,
} from './eightfold.constants';
import {
  EightfoldPosition,
  EightfoldJobsResponse,
  EightfoldPcsxResponse,
  EightfoldLocationObject,
} from './eightfold.types';

/**
 * Per-scrape state. `jobsPath` is the endpoint the tenant answers on,
 * resolved on the first page: some tenants gate `/api/apply/v2/jobs` behind
 * authorization ("Not authorized for PCSX") while leaving `/api/pcsx/search`
 * open, others are the reverse. It is remembered for the rest of ONE scrape
 * so later pages hit the working endpoint directly. It must never live on the
 * service: Nest providers are singletons, so an instance field would leak
 * tenant A's endpoint into tenant B's scrape and race between concurrent
 * scrapes.
 */
interface EightfoldScrapeContext {
  jobsPath: string | null;
}

/**
 * Eightfold AI ("PCSX" / SmartApply) careers scraper — generic, multi-tenant.
 *
 * Resolves a tenant from `companySlug` (→ `https://{slug}.eightfold.ai`) or an
 * explicit `companyUrl` custom domain, then pages the public SmartApply
 * positions API. The first page yields the total `count`; remaining pages are
 * fanned out concurrently (bounded) and merged with `Promise.allSettled` so a
 * single transient page failure never nukes the batch.
 */
@SourcePlugin({
  site: Site.EIGHTFOLD,
  name: 'Eightfold',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class EightfoldService implements IScraper {
  private readonly logger = new Logger(EightfoldService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Eightfold scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(companySlug, input.companyUrl);
    const domain = this.resolveDomain(host, companySlug);
    const companyName = this.deriveCompanyName(companySlug, host);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(EIGHTFOLD_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];
    // Endpoint resolution is per scrape (per tenant), never on the singleton
    // service — see EightfoldScrapeContext.
    const ctx: EightfoldScrapeContext = { jobsPath: null };

    try {
      this.logger.log(`Fetching Eightfold jobs for tenant: ${host} (domain=${domain})`);

      // First page → positions + true total count. It also resolves the
      // endpoint (ctx.jobsPath) before the concurrent fan-out below reads it.
      const first = await this.fetchPage(client, host, domain, 0, ctx);
      this.collect(first.positions, companySlug, companyName, host, input.descriptionFormat, seen, jobPosts);

      const total = Math.min(first.count || jobPosts.length, resultsWanted);

      if (jobPosts.length < total && first.positions.length === EIGHTFOLD_PAGE_SIZE) {
        const offsets: number[] = [];
        for (let start = EIGHTFOLD_PAGE_SIZE; start < total; start += EIGHTFOLD_PAGE_SIZE) {
          offsets.push(start);
        }

        // Bounded concurrent fan-out over the remaining pages.
        for (let i = 0; i < offsets.length; i += EIGHTFOLD_MAX_CONCURRENCY) {
          const chunk = offsets.slice(i, i + EIGHTFOLD_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((start) => this.fetchPage(client, host, domain, start, ctx)),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              this.collect(
                result.value.positions,
                companySlug,
                companyName,
                host,
                input.descriptionFormat,
                seen,
                jobPosts,
              );
            } else {
              this.logger.warn(`Eightfold page fetch failed: ${result.reason?.message ?? result.reason}`);
            }
          }
          if (i + EIGHTFOLD_MAX_CONCURRENCY < offsets.length) {
            await randomSleep(EIGHTFOLD_REQUEST_DELAY_MS, EIGHTFOLD_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Eightfold total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Eightfold scrape error for ${host}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch one positions page; returns its positions and the tenant total count.
   * Resolves the working endpoint into `ctx.jobsPath` on the first success so
   * later pages of the SAME scrape skip the doomed request.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    domain: string,
    start: number,
    ctx: EightfoldScrapeContext,
  ): Promise<{ positions: EightfoldPosition[]; count: number }> {
    const params = new URLSearchParams({
      domain,
      query: '',
      location: '',
      start: String(start),
      num: String(EIGHTFOLD_PAGE_SIZE),
      sort_by: 'timestamp',
    });
    const paths = ctx.jobsPath
      ? [ctx.jobsPath]
      : [EIGHTFOLD_JOBS_PATH, EIGHTFOLD_PCSX_SEARCH_PATH];
    let lastError: unknown = null;
    for (const path of paths) {
      const url = `${host}${path}?${params.toString()}`;
      try {
        const response = await client.get(url);
        const payload = this.unwrapPositionsAndCount(response.data);
        if (payload) {
          ctx.jobsPath = path;
          return payload;
        }
      } catch (err) {
        // A tenant can gate an endpoint behind an HTTP error (e.g. 403 on
        // /api/apply/v2/jobs) while the other stays open — fall through.
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return { positions: [], count: 0 };
  }

  /**
   * Positions + total count out of either endpoint's envelope:
   * `{positions, count}` at top level (SmartApply) or nested under `data`
   * (PCSX search). Returns null for bodies without a payload — an HTML
   * shell or a `{"message": "Not authorized for PCSX"}` gate — so the
   * caller can try the next endpoint.
   */
  private unwrapPositionsAndCount(
    body: EightfoldJobsResponse | EightfoldPcsxResponse | unknown,
  ): { positions: EightfoldPosition[]; count: number } | null {
    if (!body || typeof body !== 'object') return null;
    const top = body as EightfoldJobsResponse;
    if (Array.isArray(top.positions) || typeof top.count === 'number') {
      return { positions: top.positions ?? [], count: top.count ?? 0 };
    }
    const wrapped = (body as EightfoldPcsxResponse).data;
    if (wrapped && (Array.isArray(wrapped.positions) || typeof wrapped.count === 'number')) {
      return { positions: wrapped.positions ?? [], count: wrapped.count ?? 0 };
    }
    return null;
  }

  /** Map raw positions → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    positions: EightfoldPosition[],
    companySlug: string | undefined,
    companyName: string,
    host: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const position of positions) {
      try {
        const post = this.processJob(position, companySlug, companyName, host, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Eightfold position ${position?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    position: EightfoldPosition,
    companySlug: string | undefined,
    companyName: string,
    host: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = position.name ?? position.posting_name ?? position.title;
    if (!title) return null;

    const atsId = String(
      position.displayJobId ??
        position.display_job_id ??
        position.id ??
        position.atsJobId ??
        position.ats_job_id ??
        '',
    );
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(position, host, atsId);

    const rawDescription = position.job_description ?? position.jobDescription ?? null;
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
      position.department ?? position.team ?? position.businessUnit ?? position.business_unit ?? position.category ?? null;

    const locations = this.extractLocations(position);

    return new JobPostDto({
      id: `eightfold-${atsId}`,
      title,
      companyName: position.companyName ?? companyName,
      jobUrl,
      location: locations[0] ?? null,
      ...(locations.length > 0 ? { locations } : {}),
      description,
      datePosted: this.parseDate(
        position.postedTs ?? position.creationTs ?? position.t_create ?? position.t_update,
      ),
      isRemote: this.detectRemote(position),
      emails: extractEmails(description),
      site: Site.EIGHTFOLD,
      atsId,
      atsType: 'eightfold',
      department,
      team: position.team ?? null,
      employmentType: position.employmentType ?? position.employment_type ?? null,
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
    return EIGHTFOLD_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(companySlug ?? ''));
  }

  /** The `domain` query param Eightfold expects — derived from the host or slug. */
  private resolveDomain(host: string, companySlug: string | undefined): string {
    if (companySlug) return `${companySlug}.com`;
    try {
      return new URL(host).host;
    } catch {
      return host;
    }
  }

  private deriveCompanyName(companySlug: string | undefined, host: string): string {
    const base = companySlug ?? new URL(host).host.split('.')[0];
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Build an absolute job URL, resolving root-relative canonical paths. */
  private buildJobUrl(position: EightfoldPosition, host: string, atsId: string): string {
    const canonical =
      position.canonicalPositionUrl ??
      position.canonical_position_url ??
      position.positionUrl ??
      position.position_url ??
      '';
    if (canonical.startsWith('/')) return `${host}${canonical}`;
    if (canonical) return canonical;
    const id = position.id ?? atsId;
    return `${host}/careers/job/${id}`;
  }

  /** Eightfold returns locations as string lists (newer) or dicts (older). */
  private extractLocations(position: EightfoldPosition): LocationDto[] {
    for (const key of ['standardizedLocations', 'locations'] as const) {
      const locs = position[key];
      if (Array.isArray(locs) && locs.length > 0) {
        return locs
          .filter((l): l is string | EightfoldLocationObject => !!l)
          .map((l) => this.locationEntry(l));
      }
    }
    const primary = position.primaryLocation ?? position.primary_location;
    if (primary && typeof primary === 'object') return [this.locationFromObject(primary)];
    if (typeof primary === 'string' && primary.trim()) {
      const parsed = parseLocationText(primary).location;
      if (parsed) return [parsed];
    }
    return [];
  }

  private locationEntry(entry: string | EightfoldLocationObject): LocationDto {
    if (entry && typeof entry === 'object') return this.locationFromObject(entry);
    // Eightfold strings are "Country, State, City" — reverse into city/state/country.
    const parts = String(entry).split(',').map((p) => p.trim()).filter(Boolean);
    const [country, state, city] = parts.length >= 3 ? parts : [parts[parts.length - 1], parts[1], parts[0]];
    return new LocationDto({ city: city ?? null, state: state ?? null, country: country ?? null });
  }

  private locationFromObject(obj: EightfoldLocationObject): LocationDto {
    return new LocationDto({
      city: obj.city ?? null,
      state: obj.state ?? null,
      country: obj.country ?? obj.name ?? null,
    });
  }

  /** Detect remote/hybrid from `workLocationOption` / `locationFlexibility`. */
  private detectRemote(position: EightfoldPosition): boolean {
    const fields = [
      position.workLocationOption,
      position.work_location_option,
      position.locationFlexibility,
      position.location_flexibility,
    ];
    for (const field of fields) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
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
