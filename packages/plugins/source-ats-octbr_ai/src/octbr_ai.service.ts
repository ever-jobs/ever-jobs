import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  decodeHtmlEntities,
  parseLocationText,
  pinUrlToHosts,
  stripHtmlTags,
} from '@ever-jobs/common';
import {
  OCTBR_AI_DATA_PAGE_RE,
  OCTBR_AI_DEFAULT_TIMEOUT_SECONDS,
  OCTBR_AI_DETAIL_CONCURRENCY,
  OCTBR_AI_HOST,
  OCTBR_AI_SLUG_RE,
} from './octbr_ai.constants';
import {
  OctbrAiDepartmentGroup,
  OctbrAiDetailJob,
  OctbrAiListJob,
} from './octbr_ai.types';

@SourcePlugin({
  site: Site.OCTBR_AI,
  name: 'Octbr',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class OctbrAiService implements IScraper {
  private readonly logger = new Logger(OctbrAiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const company = input.companySlug?.trim();
    if (!company) {
      this.logger.warn('No companySlug provided for Octbr scraper');
      return new JobResponseDto([]);
    }
    if (!OCTBR_AI_SLUG_RE.test(company)) {
      // The slug becomes the hostname: refuse anything that is not one label.
      const shown = company.slice(0, 80);
      this.logger.warn(`Octbr: refusing companySlug \`${shown}\` - not a single DNS label`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics(
          'bad_input',
          `companySlug must be one DNS label (letters, digits, hyphen; max 63), got \`${shown}\``,
        ),
      );
    }

    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 100;

    try {
      // Spec 1689 — no caller `caCert`: the shared client turns ANY caCert
      // into `rejectUnauthorized: false`, so passing the request's value let
      // an API caller switch TLS verification off. Verification stays on, as
      // the fork shipped it. Every redirect hop is re-pinned to octbr.ai.
      const client = createHttpClient({
        proxies: input.proxies,
        requestTimeout: input.requestTimeout ?? OCTBR_AI_DEFAULT_TIMEOUT_SECONDS,
        allowedRedirectHosts: [OCTBR_AI_HOST],
      });

      const listingHtml = await this.fetchText(client, this.origin(company));
      const page = this.parseDataPage(listingHtml);
      const groups = (page?.props?.jobsByDepartment ??
        []) as OctbrAiDepartmentGroup[];
      const companyName: string | null = page?.props?.organisation?.name ?? null;

      const listed: { job: OctbrAiListJob; department: string }[] = [];
      for (const group of groups) {
        for (const job of group.jobs ?? []) {
          if (listed.length >= resultsWanted) break;
          if (!job?.title) continue;
          listed.push({ job, department: group.department ?? '' });
        }
      }

      const detailUrls = listed.map(({ job }) => this.detailUrl(job, company));
      const details = await this.fetchDetails(client, detailUrls);

      listed.forEach(({ job, department }, i) => {
        jobs.push(
          this.toJobPost(job, department, company, companyName, details[i], detailUrls[i]),
        );
      });

      this.logger.log(`Octbr: scraped ${jobs.length} jobs for ${company}`);
    } catch (err: unknown) {
      this.logger.error(
        `Octbr scrape failed for ${company}: ${(err as Error)?.message ?? err}`,
      );
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  /** GET a URL as text. Isolated so tests can substitute fixtures per URL. */
  protected async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const res = await client.get<string>(url, { responseType: 'text' });
    return typeof res.data === 'string' ? res.data : '';
  }

  /**
   * Fetch detail pages in batches of {@link OCTBR_AI_DETAIL_CONCURRENCY}
   * (Spec 1689) — `resultsWanted` has no upper bound, so firing every request
   * at once let a caller open an unbounded burst against one tenant.
   * Fail-safe: a failed, skipped or unparseable page yields `undefined` for
   * that index, so the job still maps from the listing.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    urls: (string | null)[],
  ): Promise<(OctbrAiDetailJob | undefined)[]> {
    const details: (OctbrAiDetailJob | undefined)[] = new Array(urls.length).fill(undefined);
    for (let index = 0; index < urls.length; index += OCTBR_AI_DETAIL_CONCURRENCY) {
      const batch = urls.slice(index, index + OCTBR_AI_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((url) => (url ? this.fetchText(client, url) : Promise.resolve(''))),
      );
      settled.forEach((result, batchIndex) => {
        if (result.status === 'fulfilled' && result.value) {
          details[index + batchIndex] = this.parseDataPage(result.value)?.props
            ?.job as OctbrAiDetailJob | undefined;
        }
      });
    }
    return details;
  }

  /**
   * The detail-page URL we may fetch for a listed job, or `null` for none.
   *
   * `job.url` comes from the tenant's own JSON, so it is only used when it
   * resolves to https on exactly `{slug}.octbr.ai` (Spec 1689). Otherwise the
   * URL is rebuilt from `job.slug` on the tenant origin; a job with neither is
   * emitted without a description rather than fetched from somewhere else.
   */
  private detailUrl(job: OctbrAiListJob, company: string): string | null {
    const tenantHost = `${company}.${OCTBR_AI_HOST}`.toLowerCase();
    const listed = typeof job.url === 'string' ? job.url.trim() : '';
    if (listed) {
      let resolved: string | null = null;
      try {
        resolved = new URL(listed, this.origin(company)).href;
      } catch {
        resolved = null;
      }
      const pinned = pinUrlToHosts(resolved, [tenantHost], { allowSubdomains: false });
      if (pinned) return pinned;
      this.logger.debug(
        `Octbr: ignoring job.url \`${listed.slice(0, 200)}\` - not https on ${tenantHost}`,
      );
    }
    const slug = typeof job.slug === 'string' ? job.slug.trim() : '';
    return slug ? `${this.origin(company)}jobs/${encodeURIComponent(slug)}` : null;
  }

  private origin(company: string): string {
    return `https://${company}.${OCTBR_AI_HOST}/`;
  }

  /**
   * Extract the Inertia `data-page` prop: an HTML-entity-encoded JSON blob on
   * the root div. Returns null when absent or malformed.
   */
  private parseDataPage(html: string): any {
    const match = OCTBR_AI_DATA_PAGE_RE.exec(html);
    if (!match) return null;
    try {
      return JSON.parse(decodeHtmlEntities(match[1]));
    } catch {
      return null;
    }
  }

  private toJobPost(
    job: OctbrAiListJob,
    department: string,
    company: string,
    companyName: string | null,
    detail: OctbrAiDetailJob | undefined,
    detailUrl: string | null,
  ): JobPostDto {
    const locationText = (job.location ?? '').trim();
    const { location } = locationText
      ? parseLocationText(locationText)
      : { location: null };

    const jobType = getJobTypeFromString(
      job.employment_type_label ?? job.employment_type ?? '',
    );
    // Only a tenant-pinned URL is published; an off-tenant `job.url` falls
    // back to the tenant board rather than being passed on to callers.
    const jobUrl = detailUrl ?? this.origin(company);

    return new JobPostDto({
      id: `octbr_ai-${company}-${job.id ?? job.slug}`,
      site: Site.OCTBR_AI,
      title: job.title,
      companyName: companyName ?? company,
      companyUrl: this.origin(company),
      jobUrl,
      applyUrl: jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      description: this.description(detail),
      datePosted: this.datePosted(detail?.posted_date),
      isRemote:
        job.location_type === 'remote' ||
        locationText.toLowerCase().includes('remote'),
      ...(jobType ? { jobType: [jobType] } : {}),
      department: detail?.department ?? (department || null),
      atsId: String(job.id ?? job.slug),
      atsType: 'octbr_ai',
    });
  }

  /** Compose JD text from the detail page's HTML sections. */
  private description(detail: OctbrAiDetailJob | undefined): string | null {
    if (!detail) return null;
    const parts: string[] = [];
    const push = (label: string | null, html: string | null | undefined) => {
      const text = (stripHtmlTags(html ?? '') ?? '').trim();
      if (!text) return;
      parts.push(label ? `${label}\n${text}` : text);
    };
    push(null, detail.description);
    push('**Responsibilities**', detail.responsibilities);
    push('**Qualifications**', detail.requirements);
    return parts.join('\n\n').trim() || null;
  }

  private datePosted(value: string | null | undefined): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
