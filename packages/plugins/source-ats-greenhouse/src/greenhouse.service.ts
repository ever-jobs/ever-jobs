import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  CompensationDto,
  CompensationInterval,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  decodeHtmlEntities,
  extractEmails,
  parseLocationList,
  resolveCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import { GREENHOUSE_API_URL, GREENHOUSE_HARVEST_API_URL, GREENHOUSE_HEADERS } from './greenhouse.constants';
import {
  GreenhouseJob,
  GreenhouseResponse,
  GreenhouseHarvestJob,
  GreenhouseHarvestOffice,
  GreenhouseMetadataItem,
} from './greenhouse.types';

/** Block-level HTML tag names used to detect whether `content` is real or
 *  entity-encoded HTML. */
const BLOCK_TAGS = 'p|div|br|ul|ol|li|h[1-6]|span|strong|em|table';
const REAL_TAG_RE = new RegExp(`<(?:${BLOCK_TAGS})\\b`, 'i');
const ENCODED_TAG_RE = new RegExp(`&lt;(?:${BLOCK_TAGS})\\b`, 'i');

@SourcePlugin({
  site: Site.GREENHOUSE,
  name: 'Greenhouse',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class GreenhouseService implements IScraper {
  private readonly logger = new Logger(GreenhouseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Greenhouse scraper');
      return new JobResponseDto([]);
    }

    // ── Authenticated Harvest API path ──────────────────────────────
    const apiKey = input.auth?.greenhouse?.apiKey ?? process.env.GREENHOUSE_API_KEY;
    if (apiKey) {
      try {
        return await this.scrapeWithApi(apiKey, input, companySlug);
      } catch (err: any) {
        this.logger.warn(
          `Greenhouse Harvest API failed for ${companySlug}, falling back to public board: ${err.message}`,
        );
      }
    }

    // ── Public board scraping (existing behaviour) ──────────────────
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(GREENHOUSE_HEADERS);

    const url = `${GREENHOUSE_API_URL}/${encodeURIComponent(companySlug)}/jobs?content=true`;

    try {
      this.logger.log(`Fetching Greenhouse jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: GreenhouseResponse = response.data ?? { jobs: [] };
      const jobs = data.jobs ?? [];

      this.logger.log(`Greenhouse: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Greenhouse job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Greenhouse scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private processJob(
    job: GreenhouseJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const description = this.toDescription(job.content, format);

    // The posting `location.name` is the role's location and is consistently
    // equal-or-richer than the broader company `offices[]`; use it as the single
    // source and only fall back to offices when it is missing.
    const parsedLocations = parseLocationList(
      this.locationLabels(job.location?.name ?? job.offices?.[0]?.name ?? null),
    );

    // Greenhouse exposes no structured remote *flag*, so its only structured
    // remote evidence is the `offices[]` and the company-defined "Work
    // Location" metadata entry. Fold both into the isRemote OR (Spec 5027).
    const structuredRemote = parseLocationList([
      ...this.officeLabels(job.offices),
      ...this.workLocationLabels(job.metadata),
    ]);

    // Department
    const department = job.departments?.[0]?.name ?? null;

    // Date posted
    const datePosted = job.first_published ?? job.updated_at ?? null;

    const { compensation: structuredComp, employmentType } =
      this.extractMetadata(job.metadata);
    // Structured currency_range first, then fall back to the decoded body
    // (Spec 5018). Parse a plain-text body so entity-encoded markup never
    // reaches the salary matcher.
    const compensation = resolveCompensation({
      structured: structuredComp,
      text: this.salaryTextFromContent(job.content),
    });

    return new JobPostDto({
      id: `gh-${job.id}`,
      title,
      companyName: job.company_name ?? companySlug,
      jobUrl: job.absolute_url ?? `https://boards.greenhouse.io/${companySlug}/jobs/${job.id}`,
      location: parsedLocations.location,
      description,
      compensation,
      datePosted: toDateOnly(datePosted),
      isRemote: parsedLocations.remoteMentioned || structuredRemote.remoteMentioned,
      workFromHomeType: this.mergeWorkFromHomeType(
        parsedLocations.workFromHomeType,
        structuredRemote.workFromHomeType,
      ),
      employmentType,
      emails: extractEmails(description),
      site: Site.GREENHOUSE,
      // ATS-specific fields
      atsId: job.id?.toString() ?? null,
      atsType: 'greenhouse',
      department,
    });
  }

  /**
   * Turn a raw Greenhouse `content`/`notes` string into a description.
   *
   * The public job-board API returns `content` as HTML-*entity-encoded* HTML
   * (e.g. `&lt;div&gt;&lt;p&gt;`), so the shared `htmlToPlainText` — which
   * decodes entities only after stripping tags — would leave literal `<div>` /
   * `<p>` markup in the output. We detect that case per-job and decode the
   * entity layer first, yielding the real HTML the shared helper expects. If
   * Greenhouse later returns real HTML, the same content passes through
   * unchanged.
   */
  private toDescription(
    content: string | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    const html = this.normalizeContentHtml(content);
    if (!html) return null;
    return format === DescriptionFormat.HTML ? html : htmlToPlainText(html);
  }

  private normalizeContentHtml(
    content: string | null | undefined,
  ): string | null {
    if (!content) return null;
    const isEntityEncoded =
      !REAL_TAG_RE.test(content) && ENCODED_TAG_RE.test(content);
    return isEntityEncoded ? decodeHtmlEntities(content) : content;
  }

  /**
   * Plain-text view of a `content`/`notes` body for salary parsing (Spec
   * 5018). Always decodes the entity layer and strips tags regardless of the
   * requested description format, so the salary matcher never sees markup.
   */
  private salaryTextFromContent(
    content: string | null | undefined,
  ): string | null {
    const html = this.normalizeContentHtml(content);
    return html ? htmlToPlainText(html) : null;
  }

  /**
   * Split a single Greenhouse location label into the discrete labels
   * `parseLocationList` expects. Greenhouse packs multiple sites into one
   * string (e.g. `Boston, MA; Mountain View, CA`, `Paducah, KY or Los Angeles,
   * CA`, `Alameda, CA or Remote in US`), so split on `;`, ` or `, and newlines.
   */
  private locationLabels(raw: string | null): string[] {
    if (!raw) return [];
    return raw
      .split(/\s*;\s*|\s+or\s+|\r?\n/i)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  /**
   * Map Greenhouse company-defined `metadata[]` to structured fields.
   *
   * The field *name* is not standardized (`Salary` vs `Salary Range`), so the
   * reliable key is `value_type`: any `currency_range` entry carries a
   * `{unit, min_value, max_value}` shape that maps to `CompensationDto`
   * (assumed yearly — Greenhouse currency ranges carry no period). The
   * `Employment Type` single-select maps to `employmentType`.
   */
  private extractMetadata(
    metadata: GreenhouseMetadataItem[] | null | undefined,
  ): { compensation: CompensationDto | null; employmentType: string | null } {
    let compensation: CompensationDto | null = null;
    let employmentType: string | null = null;

    for (const item of metadata ?? []) {
      if (!item) continue;
      const valueType = item.value_type?.toLowerCase() ?? '';
      if (!compensation && valueType === 'currency_range') {
        compensation = this.parseCurrencyRange(item.value);
      }
      if (!employmentType && item.name?.toLowerCase() === 'employment type') {
        if (typeof item.value === 'string' && item.value.trim()) {
          employmentType = item.value.trim();
        }
      }
    }

    return { compensation, employmentType };
  }

  private parseCurrencyRange(
    value: GreenhouseMetadataItem['value'],
  ): CompensationDto | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const minAmount = this.toAmount(record.min_value);
    const maxAmount = this.toAmount(record.max_value);
    if (minAmount === null && maxAmount === null) return null;
    const currency =
      typeof record.unit === 'string' && record.unit.trim()
        ? record.unit.trim()
        : 'USD';
    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount,
      maxAmount,
      currency,
    });
  }

  private toAmount(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  // ─── Harvest API (authenticated) ───────────────────────────────────

  /**
   * Scrape jobs using the official Greenhouse Harvest API.
   *
   * The Harvest API returns richer data than the public board API:
   * full HTML descriptions, departments, offices with addresses,
   * custom fields, confidential flags, and more.
   *
   * Uses Basic Auth with the API key as the username and an empty password.
   *
   * @see https://developers.greenhouse.io/harvest.html#list-jobs
   */
  private async scrapeWithApi(
    apiKey: string,
    input: ScraperInputDto,
    companySlug: string,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `Using authenticated Greenhouse Harvest API for company: ${companySlug}`,
    );

    const authHeader = `Basic ${Buffer.from(apiKey + ':').toString('base64')}`;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...GREENHOUSE_HEADERS,
      Authorization: authHeader,
    });

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];
    let page = 1;

    while (jobPosts.length < resultsWanted) {
      const perPage = Math.min(100, resultsWanted - jobPosts.length);
      const url = `${GREENHOUSE_HARVEST_API_URL}/jobs?per_page=${perPage}&page=${page}`;

      this.logger.log(`Harvest API: fetching page ${page} (per_page=${perPage})`);
      const response = await client.get<GreenhouseHarvestJob[]>(url);

      const rawJobs: GreenhouseHarvestJob[] = response.data ?? [];
      if (rawJobs.length === 0) {
        this.logger.log('Harvest API: no more jobs available');
        break;
      }

      this.logger.log(`Harvest API: received ${rawJobs.length} jobs on page ${page}`);

      for (const job of rawJobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processHarvestJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Harvest job ${job.id}: ${err.message}`);
        }
      }

      // If we got fewer results than requested per_page, we've hit the last page
      if (rawJobs.length < perPage) break;
      page++;
    }

    this.logger.log(
      `Harvest API: returning ${jobPosts.length} jobs for ${companySlug}`,
    );
    return new JobResponseDto(jobPosts);
  }

  /**
   * Map a Greenhouse Harvest API job object to a `JobPostDto`.
   */
  private processHarvestJob(
    job: GreenhouseHarvestJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.name;
    if (!title) return null;

    // Skip template and non-open jobs
    if (job.is_template) return null;
    if (job.status && job.status !== 'open') return null;

    // The Harvest API does not return description/content on the
    // list endpoint — use notes if available (often HTML)
    const description = this.toDescription(job.notes, format);

    // Location: prefer office name, fall back to office location name
    const office: GreenhouseHarvestOffice | null = job.offices?.[0] ?? null;
    const parsedLocations = parseLocationList(
      this.locationLabels(office?.name ?? office?.location?.name ?? null),
    );

    // Greenhouse has no structured remote flag; the Harvest `offices[]` are the
    // only structured remote evidence here. Fold them into the isRemote OR
    // (Spec 5027). The Harvest list endpoint carries no company metadata.
    const structuredRemote = parseLocationList(this.officeLabels(job.offices));

    // Department
    const department = job.departments?.[0]?.name ?? null;

    // Date posted: prefer opened_at, fall back to created_at / updated_at
    const datePosted = job.opened_at ?? job.created_at ?? job.updated_at ?? null;

    return new JobPostDto({
      id: `gh-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl: `https://boards.greenhouse.io/${companySlug}/jobs/${job.id}`,
      location: parsedLocations.location,
      description,
      compensation: resolveCompensation({
        text: this.salaryTextFromContent(job.notes),
      }),
      datePosted: toDateOnly(datePosted),
      isRemote: parsedLocations.remoteMentioned || structuredRemote.remoteMentioned,
      workFromHomeType: this.mergeWorkFromHomeType(
        parsedLocations.workFromHomeType,
        structuredRemote.workFromHomeType,
      ),
      emails: extractEmails(description),
      site: Site.GREENHOUSE,
      // ATS-specific fields
      atsId: job.id?.toString() ?? null,
      atsType: 'greenhouse',
      department,
    });
  }

  /**
   * Office name / location strings usable as remote-evidence labels. Accepts
   * both the public-board office shape (`location` is a string) and the
   * Harvest office shape (`location` is `{ name }`).
   */
  private officeLabels(
    offices:
      | Array<{
          name?: string | null;
          location?: string | { name?: string | null } | null;
        }>
      | null
      | undefined,
  ): string[] {
    const labels: string[] = [];
    for (const office of offices ?? []) {
      if (!office) continue;
      labels.push(...this.locationLabels(office.name ?? null));
      const loc = office.location;
      const locName = typeof loc === 'string' ? loc : (loc?.name ?? null);
      labels.push(...this.locationLabels(locName));
    }
    return labels;
  }

  /**
   * Values of the company-defined "Work Location" `metadata` entry, as
   * remote-evidence labels. The field is operator-named, so it is matched
   * case-insensitively on `name`; its value may be a single string or a
   * multi-select array.
   */
  private workLocationLabels(
    metadata: GreenhouseMetadataItem[] | null | undefined,
  ): string[] {
    const labels: string[] = [];
    for (const item of metadata ?? []) {
      if (!item || item.name?.toLowerCase() !== 'work location') continue;
      const value = item.value;
      if (typeof value === 'string') {
        labels.push(...this.locationLabels(value));
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string') labels.push(...this.locationLabels(entry));
        }
      }
    }
    return labels;
  }

  /**
   * Combine two `workFromHomeType` signals. Prefers a present value, keeps a
   * shared value, and widens to `Hybrid or Remote` when they genuinely differ
   * (mirrors the merge used across the ATS plugins).
   */
  private mergeWorkFromHomeType(
    a: string | null,
    b: string | null,
  ): string | null {
    if (!a) return b;
    if (!b || a === b) return a;
    return 'Hybrid or Remote';
  }
}
