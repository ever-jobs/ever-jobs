import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  CompensationDto,
  getCompensationInterval,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import {
  BUILDNEBULA_COMPANY_NAME,
  BUILDNEBULA_DEFAULT_TIMEOUT_SECONDS,
  BUILDNEBULA_LISTINGS_PATH,
  BUILDNEBULA_ORIGIN,
  BUILDNEBULA_TEAM_LABELS,
} from './buildnebula.constants';
import {
  BuildnebulaListing,
  BuildnebulaListingsResponse,
  BuildnebulaLocation,
} from './buildnebula.types';

@SourcePlugin({
  site: Site.BUILDNEBULA,
  name: BUILDNEBULA_COMPANY_NAME,
  category: 'company',
  companyDomains: ['buildnebula.com'],
})
@Injectable()
export class BuildnebulaService implements IScraper {
  private readonly logger = new Logger(BuildnebulaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no listings returned by the Nebula careers API'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Nebula: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Nebula scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? BUILDNEBULA_DEFAULT_TIMEOUT_SECONDS,
    });

    const origin = this.origin(input.companyUrl);
    const res = await client.get<BuildnebulaListingsResponse>(
      `${origin}${BUILDNEBULA_LISTINGS_PATH}`,
    );
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    return items
      .filter((item) => this.isVisible(item))
      .map((item) => this.toJobPost(item, origin))
      .filter((job): job is JobPostDto => job !== null);
  }

  /** Drop non-live rows when the row declares its visibility. */
  private isVisible(item: BuildnebulaListing): boolean {
    if (item.status && item.status !== 'published') return false;
    if (item.takedown === true) return false;
    if (item.visibility && item.visibility !== 'public') return false;
    return true;
  }

  private toJobPost(item: BuildnebulaListing, origin: string): JobPostDto | null {
    const job = item.job ?? {};
    const title = this.normalize(job.title);
    const slug = this.normalize(item.slug);
    if (!title || !slug) return null;

    const jobUrl = `${origin}/careers/${slug}`;
    const locations = (job.locations ?? [])
      .map((loc) => this.toLocation(loc))
      .filter((loc): loc is LocationDto => loc !== null);
    const location = locations[0] ?? null;
    const isRemote = (job.locations ?? []).some(
      (loc) => this.normalize(loc.workplace_type).toLowerCase() === 'remote',
    );
    const jobType = job.employment_type
      ? getJobTypeFromString(job.employment_type.replace(/_/g, '-'))
      : null;
    const compensation = this.toCompensation(item);
    const description = this.buildDescription(item);
    const team = this.teamLabel(job.team);

    return new JobPostDto({
      id: `buildnebula-${slug}`,
      atsId: slug,
      site: Site.BUILDNEBULA,
      atsType: 'buildnebula',
      title,
      companyName: BUILDNEBULA_COMPANY_NAME,
      companyUrl: origin,
      jobUrl,
      jobUrlDirect: jobUrl,
      applyUrl: jobUrl,
      location,
      ...(locations.length ? { locations } : {}),
      ...(job.department ? { department: this.normalize(job.department) } : {}),
      ...(team ? { team } : {}),
      jobType: jobType ? [jobType] : null,
      ...(job.employment_type ? { employmentType: job.employment_type } : {}),
      ...(isRemote ? { isRemote: true } : {}),
      ...(compensation ? { compensation } : {}),
      ...(item.published_at ? { datePosted: item.published_at } : {}),
      ...(description ? { description } : {}),
    });
  }

  private toLocation(loc: BuildnebulaLocation): LocationDto | null {
    const city = this.normalize(loc.city);
    const state = this.normalize(loc.state);
    const country = this.normalize(loc.country);
    if (!city && !state && !country) return null;
    return new LocationDto({
      city: city || null,
      state: state || null,
      country: country || null,
    });
  }

  private toCompensation(item: BuildnebulaListing): CompensationDto | null {
    const c = item.job?.compensation;
    if (!c || (c.min == null && c.max == null)) return null;
    const interval = c.period ? getCompensationInterval(c.period) : null;
    return new CompensationDto({
      minAmount: c.min ?? null,
      maxAmount: c.max ?? null,
      currency: this.normalize(c.currency) || 'USD',
      ...(interval ? { interval } : {}),
    });
  }

  /** The SPA renders sections under these headings; mirror them verbatim. */
  private buildDescription(item: BuildnebulaListing): string {
    const job = item.job ?? {};
    const sections = job.description_sections ?? {};
    const parts: string[] = [];
    const push = (heading: string, body?: string, bullets?: string[]) => {
      const lines = [
        heading,
        this.normalize(body),
        ...(bullets ?? []).filter(Boolean).map((b) => `- ${b}`),
      ].filter(Boolean);
      if (lines.length > 1) parts.push(lines.join('\n'));
    };

    push('What to Expect', sections.prose);
    push("What You'll Do", undefined, sections.responsibilities);
    push("What You'll Bring", undefined, sections.requirements);
    push('Nice to Have', undefined, sections.nice_to_have);
    for (const para of job.closing_paragraphs ?? []) {
      const text = this.normalize(para);
      if (text) parts.push(text);
    }
    push('Benefits', undefined, job.benefits);

    const comp = [item.compensation_line, item.equity_sentence]
      .map((s) => this.normalize(s))
      .filter(Boolean);
    if (comp.length) parts.push(comp.join(' '));
    return parts.join('\n\n');
  }

  private teamLabel(team?: string): string | null {
    const token = this.normalize(team);
    if (!token) return null;
    return (
      BUILDNEBULA_TEAM_LABELS[token] ??
      token
        .split(/[_-]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    );
  }

  /** Origin of `companyUrl` (or the careers URL a caller passed), else default. */
  private origin(companyUrl?: string): string {
    const raw = this.normalize(companyUrl);
    if (!raw) return BUILDNEBULA_ORIGIN;
    const m = /^(https?:\/\/[^/]+)/i.exec(raw);
    return m ? m[1] : BUILDNEBULA_ORIGIN;
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.description].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
      );
    }

    const locationTerm = this.normalize(input.location).toLowerCase();
    if (locationTerm) {
      filtered = filtered.filter((job) =>
        this.normalize(job.location?.displayLocation())
          .toLowerCase()
          .includes(locationTerm),
      );
    }

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(input.resultsWanted, 100);
    return filtered.slice(offset, offset + requested);
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.split(String.fromCharCode(160)).join(' ').replace(/\s+/g, ' ').trim();
  }
}
