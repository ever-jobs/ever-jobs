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
import { createHttpClient, parseLocationText } from '@ever-jobs/common';
import {
  POWER_US_CAREERS_API_URL,
  POWER_US_COMPANY_NAME,
  POWER_US_DEFAULT_TIMEOUT_SECONDS,
  POWER_US_ORIGIN,
} from './power-us.constants';
import { PowerUsCareerEntry } from './power-us.types';

@SourcePlugin({
  site: Site.POWER_US,
  name: 'Powerus',
  category: 'company',
  companyDomains: ['power.us'],
})
@Injectable()
export class PowerUsService implements IScraper {
  private readonly logger = new Logger(PowerUsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no jobs returned by the Powerus careers API'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Powerus: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Powerus scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? POWER_US_DEFAULT_TIMEOUT_SECONDS,
    });

    const res = await client.get<PowerUsCareerEntry[]>(POWER_US_CAREERS_API_URL);
    const entries = Array.isArray(res.data) ? res.data : [];
    return entries
      .map((entry) => this.toJobPost(entry))
      .filter((job): job is JobPostDto => job !== null);
  }

  private toJobPost(entry: PowerUsCareerEntry): JobPostDto | null {
    const title = this.normalize(entry.title);
    if (!title) return null;

    const atsId = this.linkedinJobId(entry.linkedInUrl) ?? this.slugFromTitle(title);
    const parsed = entry.location ? parseLocationText(entry.location) : null;
    const location = parsed?.location ?? null;
    const jobType = entry.type ? getJobTypeFromString(entry.type) : null;
    const description = this.buildDescription(entry);
    const jobUrl = this.normalize(entry.linkedInUrl) || `${POWER_US_ORIGIN}/careers`;

    return new JobPostDto({
      id: `power_us-${atsId}`,
      atsId,
      site: Site.POWER_US,
      atsType: 'power_us',
      title,
      companyName: POWER_US_COMPANY_NAME,
      companyUrl: POWER_US_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(entry.department ? { department: this.normalize(entry.department) } : {}),
      jobType: jobType ? [jobType] : null,
      ...(entry.type ? { employmentType: entry.type } : {}),
      ...(description ? { description } : {}),
    });
  }

  private linkedinJobId(linkedInUrl?: string): string | null {
    const m = /linkedin\.com\/jobs\/view\/(\d+)/.exec(linkedInUrl ?? '');
    return m ? m[1] : null;
  }

  private buildDescription(entry: PowerUsCareerEntry): string {
    const sections: string[] = [];
    const summary = this.normalize(entry.summary);
    if (summary) sections.push(summary);
    if (entry.responsibilities?.length) {
      sections.push(`Responsibilities:\n${entry.responsibilities.map((r) => `- ${r}`).join('\n')}`);
    }
    if (entry.qualifications?.length) {
      sections.push(`Qualifications:\n${entry.qualifications.map((r) => `- ${r}`).join('\n')}`);
    }
    if (entry.preferredSkills?.length) {
      sections.push(`Preferred skills:\n${entry.preferredSkills.map((r) => `- ${r}`).join('\n')}`);
    }
    return sections.join('\n\n');
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

  private slugFromTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
