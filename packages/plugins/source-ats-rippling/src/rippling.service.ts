import { SourcePlugin } from "@ever-jobs/plugin";

import { Injectable, Logger } from "@nestjs/common";
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  getJobTypeFromString,
  getCompensationInterval,
  classifyScrapeError,
  ScrapeDiagnostics,
} from "@ever-jobs/models";
import {
  createHttpClient,
  extractEmails,
  htmlToPlainText,
  markdownConverter,
  normalizeUsState,
  parseLocationList,
  parseLocationText,
  regionNameFromCode,
  salaryToCompensation,
  aggregateCompensation,
} from "@ever-jobs/common";
import {
  RIPPLING_BASE_URL,
  RIPPLING_DETAIL_CONCURRENCY,
  RIPPLING_HEADERS,
  ripplingDetailUrl,
} from "./rippling.constants";
import {
  RipplingJob,
  RipplingLocation,
  RipplingNextData,
  RipplingPayRangeDetail,
} from "./rippling.types";

const RIPPLING_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@SourcePlugin({
  site: Site.RIPPLING,
  name: "Rippling",
  category: "ats",
  isAts: true,
})
@Injectable()
export class RipplingService implements IScraper {
  private readonly logger = new Logger(RipplingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn("No companySlug provided for Rippling scraper");
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(RIPPLING_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    if (resultsWanted <= 0) return new JobResponseDto([]);

    const listedJobs: RipplingJob[] = [];
    const seenJobIds = new Set<string>();
    let diagnostics: ScrapeDiagnostics | undefined;

    for (let page = 0; listedJobs.length < resultsWanted; page++) {
      const url = this.buildJobsUrl(companySlug, page);
      let jobs: RipplingJob[];

      try {
        this.logger.log(
          `Fetching Rippling jobs for ${companySlug}, page ${page}`,
        );
        const response = await client.get(url);
        const html: string =
          typeof response.data === "string"
            ? response.data
            : JSON.stringify(response.data);
        jobs = this.extractJobsFromHtml(html);
      } catch (err: any) {
        const message = `Rippling page ${page} failed for ${companySlug}: ${err.message}`;
        if (page === 0) {
          this.logger.error(message);
          diagnostics = classifyScrapeError(err);
        } else
          this.logger.warn(
            `${message}; returning ${listedJobs.length} partial results`,
          );
        break;
      }

      if (jobs.length === 0) break;
      this.logger.log(
        `Rippling: found ${jobs.length} raw jobs on page ${page}`,
      );

      let newJobsOnPage = 0;
      for (const job of jobs) {
        if (listedJobs.length >= resultsWanted) break;

        const sourceId = this.getSourceIdentity(job);
        if (!sourceId) continue;
        if (seenJobIds.has(sourceId)) continue;
        seenJobIds.add(sourceId);
        newJobsOnPage++;

        listedJobs.push(job);
      }

      // Rippling may redirect an out-of-range page to an earlier page. A page
      // with no unseen source IDs is therefore the reliable exhaustion signal.
      if (newJobsOnPage === 0) break;
    }

    const enrichedJobs = await this.enrichJobsFromDetails(
      client,
      listedJobs,
      companySlug,
    );
    const jobPosts = enrichedJobs
      .map((job) => {
        try {
          return this.processJob(job, companySlug, input.descriptionFormat);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Rippling job ${job.id}: ${err.message}`,
          );
          return null;
        }
      })
      .filter((post): post is JobPostDto => post !== null);

    this.logger.log(
      `Rippling: scraped ${jobPosts.length} jobs for ${companySlug}`,
    );
    return new JobResponseDto(
      jobPosts,
      jobPosts.length ? undefined : diagnostics,
    );
  }

  private buildJobsUrl(companySlug: string, page: number): string {
    const slug = encodeURIComponent(companySlug);
    return `${RIPPLING_BASE_URL}/${slug}/jobs?page=${page}&jobBoardSlug=${slug}`;
  }

  private getSourceIdentity(job: RipplingJob): string | null {
    const sourceId = job.uuid ?? job.id;
    return typeof sourceId === "string" &&
      RIPPLING_JOB_ID_PATTERN.test(sourceId)
      ? sourceId
      : null;
  }

  private async enrichJobsFromDetails(
    client: ReturnType<typeof createHttpClient>,
    jobs: RipplingJob[],
    companySlug: string,
  ): Promise<RipplingJob[]> {
    const enriched: RipplingJob[] = [];

    for (
      let index = 0;
      index < jobs.length;
      index += RIPPLING_DETAIL_CONCURRENCY
    ) {
      const batch = jobs.slice(index, index + RIPPLING_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((job) => this.enrichJobFromDetail(client, job, companySlug)),
      );

      settled.forEach((result, batchIndex) => {
        enriched.push(
          result.status === "fulfilled" ? result.value : batch[batchIndex],
        );
      });
    }

    return enriched;
  }

  private async enrichJobFromDetail(
    client: ReturnType<typeof createHttpClient>,
    job: RipplingJob,
    companySlug: string,
  ): Promise<RipplingJob> {
    const sourceId = this.getSourceIdentity(job);
    if (!sourceId) return job;

    try {
      const response = await client.get<unknown>(
        ripplingDetailUrl(companySlug, sourceId),
        { headers: { Accept: "application/json" } },
      );
      const detail = this.unwrapDetailJob(response.data);
      if (!detail) return job;
      return {
        ...job,
        description: this.hasDescription(detail.description)
          ? detail.description
          : job.description,
        applyUrl: this.nonEmptyString(detail.applyUrl) ?? job.applyUrl,
        companyName:
          this.nonEmptyString(detail.companyName) ?? job.companyName,
        createdOn: this.nonEmptyString(detail.createdOn) ?? job.createdOn,
        employmentType:
          this.nonEmptyString(detail.employmentType?.label) != null
            ? detail.employmentType
            : job.employmentType,
        locations:
          detail.locations && detail.locations.length > 0
            ? detail.locations
            : job.locations,
        workLocations:
          detail.workLocations && detail.workLocations.length > 0
            ? detail.workLocations
            : job.workLocations,
        payRangeDetails:
          detail.payRangeDetails && detail.payRangeDetails.length > 0
            ? detail.payRangeDetails
            : job.payRangeDetails,
      };
    } catch (err: any) {
      this.logger.warn(
        `Rippling detail failed for ${sourceId}: ${err.message}`,
      );
      return job;
    }
  }

  private unwrapDetailJob(payload: unknown): RipplingJob | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return null;
    const record = payload as Record<string, unknown>;
    const nested = record.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as RipplingJob;
    }
    return record as RipplingJob;
  }

  private hasDescription(description: RipplingJob["description"]): boolean {
    return (
      !!description &&
      [description.company, description.role].some(
        (part) => typeof part === "string" && part.trim().length > 0,
      )
    );
  }

  private nonEmptyString(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  /**
   * Extract job data from HTML page by finding and parsing the __NEXT_DATA__ script tag.
   * Rippling uses Next.js SSR which embeds the initial data as JSON in a script tag.
   */
  private extractJobsFromHtml(html: string): RipplingJob[] {
    // Find __NEXT_DATA__ script content using regex (no DOM parser needed)
    const nextDataMatch = html.match(
      /<script\s+id="__NEXT_DATA__"\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/i,
    );

    if (!nextDataMatch?.[1]) {
      this.logger.warn("Could not find __NEXT_DATA__ in Rippling HTML");
      return [];
    }

    try {
      const nextData: RipplingNextData = JSON.parse(nextDataMatch[1]);

      // Navigate the nested structure to find job items
      const queries = nextData.props?.pageProps?.dehydratedState?.queries ?? [];
      let foundItemsArray = false;

      for (const query of queries) {
        const items = query.state?.data?.items;
        if (Array.isArray(items)) {
          foundItemsArray = true;
          const jobs = items.filter((item): item is RipplingJob =>
            this.isRipplingJob(item),
          );
          if (jobs.length > 0) return jobs;
        }
      }

      if (foundItemsArray) return [];

      // Fallback: try other common paths in the data structure
      const pageProps = nextData.props?.pageProps;
      if (pageProps) {
        // Some Rippling boards use a different structure
        const jobs = (pageProps as Record<string, unknown>).jobs;
        if (Array.isArray(jobs)) {
          return jobs.filter((job): job is RipplingJob =>
            this.isRipplingJob(job),
          );
        }
      }

      this.logger.warn("No job items found in Rippling __NEXT_DATA__");
      return [];
    } catch (err: any) {
      this.logger.error(`Error parsing Rippling __NEXT_DATA__: ${err.message}`);
      return [];
    }
  }

  private processJob(
    job: RipplingJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    if (!this.isRipplingJob(job)) return null;
    const sourceId = this.getSourceIdentity(job)!;
    const title = job.title ?? job.name;

    const description = this.formatDescription(job.description, format);

    const companyName = this.nonEmptyString(job.companyName) ?? companySlug;

    // Structured per-site locations are the primary source; the free-text
    // workLocations/parseable pay-band labels are a fallback only when no
    // structured entry carries geography.
    const wire = this.locationsFromWire(job, companyName);
    let locations = [...wire.sites, ...wire.named];
    let location: LocationDto | null = null;
    let remoteMentioned = wire.remoteMentioned;
    let parsedWorkFromHomeType: string | null = null;

    if (wire.sites.length > 0) {
      location = this.mergeSites(wire.sites);
    } else {
      const fallback = parseLocationList(this.fallbackLocationLabels(job));
      location = fallback.location;
      locations = [...fallback.locations, ...wire.named];
      remoteMentioned = remoteMentioned || fallback.remoteMentioned;
      parsedWorkFromHomeType = fallback.workFromHomeType;
    }

    const isRemote = this.hasRemoteWorkplaceType(job) || remoteMentioned;

    const workFromHomeType =
      this.workFromHomeTypeFromWorkplaceType(job) ?? parsedWorkFromHomeType;

    // Compensation: prefer the structured payRangeDetails, fall back to
    // parsing the description free text (pay-transparency ranges in the body).
    const structuredComp = this.extractCompensation(job.payRangeDetails);
    const compensation =
      structuredComp?.compensation ??
      this.extractCompensationFromText(job.description);
    const salarySource = structuredComp?.salarySource ?? null;

    const employmentType = job.employmentType?.label?.trim() || null;
    const mappedJobType = employmentType
      ? getJobTypeFromString(employmentType)
      : null;

    const department = job.department?.name?.trim() || null;

    const jobUrl =
      job.url ?? `${RIPPLING_BASE_URL}/${companySlug}/jobs/${sourceId}`;
    const applyUrl = job.applyUrl?.trim();

    return new JobPostDto({
      id: `rippling-${sourceId}`,
      title: title!.trim(),
      companyName,
      companyUrl: `${RIPPLING_BASE_URL}/${encodeURIComponent(companySlug)}/jobs`,
      jobUrl,
      ...(applyUrl && applyUrl !== jobUrl ? { applyUrl } : {}),
      location,
      ...(locations.length > 0 ? { locations } : {}),
      description,
      compensation,
      datePosted: this.nonEmptyString(job.createdOn),
      isRemote,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(salarySource ? { salarySource } : {}),
      emails: extractEmails(description),
      site: Site.RIPPLING,
      // ATS-specific fields
      atsId: sourceId,
      atsType: "rippling",
      department,
      ...(employmentType ? { employmentType } : {}),
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
    });
  }

  private formatDescription(
    source: RipplingJob["description"],
    format?: DescriptionFormat,
  ): string | null {
    if (!source) return null;
    const html = [source.company, source.role]
      .filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      )
      .map((part) => part.trim())
      .join("\n\n");
    if (!html) return null;

    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.PLAIN) return htmlToPlainText(html);
    return markdownConverter(html) ?? html;
  }

  /**
   * Fail closed on dehydrated query items. Rippling embeds filter option arrays
   * (locations, departments, and similar data) beside the actual jobs query;
   * those objects may have a `name` but are not job postings.
   */
  private isRipplingJob(value: unknown): value is RipplingJob {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const job = value as RipplingJob;
    const sourceId = job.uuid ?? job.id;
    const title = job.title ?? job.name;
    if (
      typeof sourceId !== "string" ||
      !RIPPLING_JOB_ID_PATTERN.test(sourceId) ||
      typeof title !== "string" ||
      title.trim().length === 0
    ) {
      return false;
    }

    const hasJobUrl = typeof job.url === "string" && job.url.includes("/jobs/");
    const hasDescription =
      !!job.description &&
      typeof job.description === "object" &&
      (typeof job.description.role === "string" ||
        typeof job.description.company === "string");
    const hasStructuredJobFields =
      Array.isArray(job.locations) ||
      Array.isArray(job.workLocations) ||
      !!job.department ||
      !!job.employmentType;

    return hasJobUrl || hasDescription || hasStructuredJobFields;
  }

  /**
   * Map each structured `locations[]` entry directly to a `LocationDto` — no
   * text round-trip. Entries carrying geography (city/state/country) are
   * `sites`; name-only entries are kept in `named` unless they are remote
   * markers or merely restate `companyName` (the hiring entity).
   */
  private locationsFromWire(
    job: RipplingJob,
    companyName: string | null,
  ): { sites: LocationDto[]; named: LocationDto[]; remoteMentioned: boolean } {
    const sites: LocationDto[] = [];
    const named: LocationDto[] = [];
    const seen = new Set<string>();
    let remoteMentioned = false;

    for (const loc of job.locations ?? []) {
      const name = loc.name?.trim() || null;
      const city = loc.city?.trim() || null;
      const state =
        loc.stateCode?.trim() ||
        (loc.state ? normalizeUsState(loc.state) ?? loc.state.trim() : null) ||
        null;
      const country = this.wireCountry(loc);
      const remote =
        loc.workplaceType?.toUpperCase() === "REMOTE" ||
        /\bremote\b/i.test(name ?? "");

      if (!city && !state && !country) {
        // No geography at all: a remote marker is consumed as a signal; a
        // real company name adds nothing; anything else is kept as a
        // name-only entry (e.g. a hiring entity or office label).
        remoteMentioned = remoteMentioned || remote;
        if (
          !remote &&
          name &&
          name.toLowerCase() !== companyName?.toLowerCase()
        ) {
          named.push(new LocationDto({ name }));
        }
        continue;
      }

      remoteMentioned = remoteMentioned || remote;
      const key = [name, city, state, country]
        .filter(Boolean)
        .join("|")
        .toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push(new LocationDto({ name, city, state, country }));
    }

    return { sites, named, remoteMentioned };
  }

  /** Resolve a wire entry's country display name from its alpha-2 code or literal name. */
  private wireCountry(loc: RipplingLocation): string | null {
    const code = loc.countryCode ?? loc.country;
    return (
      (code ? regionNameFromCode(code) ?? undefined : undefined) ??
      loc.country?.trim() ??
      null
    );
  }

  /**
   * Merge structured sites into the singular compat `location`: city is the
   * semicolon-joined per-site labels (`City, ST` or `City, Country` when no
   * state), country only when all sites share one.
   */
  private mergeSites(sites: LocationDto[]): LocationDto {
    const countries = new Set(
      sites
        .map((site) => site.country)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        ),
    );
    const commonCountry = countries.size === 1 ? [...countries][0] : null;

    if (sites.length === 1) {
      const site = sites[0];
      return new LocationDto({
        city: site.city,
        state: site.state,
        country: site.country ?? commonCountry,
      });
    }

    const labels = sites.map((site) =>
      [site.city, site.state ?? site.country]
        .filter((part): part is string => !!part)
        .join(", "),
    );
    return new LocationDto({ city: labels.join("; "), country: commonCountry });
  }

  /**
   * Free-text labels for the parser fallback: `workLocations` strings plus
   * `payRangeDetails[].location` values that actually parse as a place
   * (rejects non-location band labels like "Manager").
   */
  private fallbackLocationLabels(job: RipplingJob): string[] {
    const labels: string[] = [];

    for (const workLocation of job.workLocations ?? []) {
      if (typeof workLocation === "string" && workLocation.trim().length > 0) {
        labels.push(workLocation.trim());
      }
    }

    for (const detail of job.payRangeDetails ?? []) {
      const label = detail.location?.trim();
      if (label && parseLocationText(label).location?.state) {
        labels.push(label);
      }
    }

    return labels;
  }

  private hasRemoteWorkplaceType(job: RipplingJob): boolean {
    return (
      (job.locations ?? []).some(
        (loc) => loc.workplaceType?.toUpperCase() === "REMOTE",
      ) ||
      (job.workLocations ?? []).some((loc) =>
        loc.toLowerCase().includes("remote"),
      ) ||
      (job.payRangeDetails ?? []).some((detail) => detail.isRemote === true)
    );
  }

  /** Map Rippling's per-location workplaceType to a workFromHomeType label. ON_SITE yields none. */
  private workFromHomeTypeFromWorkplaceType(job: RipplingJob): string | null {
    const types = new Set(
      (job.locations ?? [])
        .map((loc) => loc.workplaceType?.toUpperCase())
        .filter((value): value is string => !!value),
    );
    const hybrid = types.has("HYBRID");
    const remote = types.has("REMOTE");
    if (hybrid && remote) return "Hybrid or Remote";
    if (hybrid) return "Hybrid";
    if (remote) return "Remote";
    return null;
  }

  /**
   * Extract structured compensation from payRangeDetails. Multiple bands are
   * collapsed into a min–max envelope (min rangeStart, max rangeEnd). When the
   * bands carry distinct ranges (by location, work mode, or role level), the
   * per-band detail is preserved in `salarySource`, semicolon-joined
   * (e.g. "Oakland, CA 130,000–200,000; Sandy, UT 115,000–155,000").
   */
  private extractCompensation(
    payRangeDetails?: RipplingPayRangeDetail[] | null,
  ): { compensation: CompensationDto; salarySource: string | null } | null {
    const details = (payRangeDetails ?? []).filter(
      (detail) =>
        detail && (detail.rangeStart != null || detail.rangeEnd != null),
    );
    if (details.length === 0) return null;

    // Collapse the bands into one overall min-max envelope (Spec 5019).
    const compensation = aggregateCompensation(
      details.map((detail) => ({
        minAmount: detail.rangeStart,
        maxAmount: detail.rangeEnd,
        currency: detail.currency ?? "USD",
        interval: getCompensationInterval(detail.frequency ?? ""),
      })),
    );
    if (!compensation) return null;

    const distinctRanges = new Set(
      details.map((detail) => `${detail.rangeStart}-${detail.rangeEnd}`),
    );
    const salarySource =
      distinctRanges.size > 1
        ? details.map((detail) => this.formatPayBand(detail)).join("; ")
        : null;

    return { compensation, salarySource };
  }

  /** Format one pay band as "<label> <start>–<end>", e.g. "Manager 140,000–170,000". */
  private formatPayBand(detail: RipplingPayRangeDetail): string {
    const range = [detail.rangeStart, detail.rangeEnd]
      .filter((value): value is number => value != null)
      .map((value) => Math.round(value).toLocaleString("en-US"))
      .join("\u2013");
    const label = detail.location?.trim();
    return label ? `${label} ${range}` : range;
  }

  /** Fallback: parse a pay-transparency salary range from the description body text. */
  private extractCompensationFromText(
    source: RipplingJob["description"],
  ): CompensationDto | null {
    const html = [source?.company, source?.role]
      .filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      )
      .join("\n\n");
    if (!html) return null;

    return salaryToCompensation(htmlToPlainText(html));
  }
}
