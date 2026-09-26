import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  Country,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, HttpClient, toDateOnly } from '@ever-jobs/common';
import {
  HLABORATORIES_CAREERS_URL,
  HLABORATORIES_COMPANY_NAME,
  HLABORATORIES_DEFAULT_RESULTS,
  HLABORATORIES_DEFAULT_TIMEOUT_SECONDS,
  HLABORATORIES_ORIGIN,
  HLABORATORIES_ROLES_PATH,
} from './hlaboratories.constants';

interface HlaboratoriesRole {
  id: number;
  title: string;
  department?: string | null;
  location?: string | null;
  employment_type?: string | null;
  remote?: boolean | null;
  description?: string | null;
  requirements?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  is_open?: boolean | null;
  created_at?: string | null;
  closed_at?: string | null;
  application_count?: number | null;
}

@SourcePlugin({
  site: Site.HLABORATORIES,
  name: 'HLabs',
  category: 'company',
  companyDomains: ['hlaboratories.com'],
})
@Injectable()
export class HlaboratoriesService implements IScraper {
  private readonly logger = new Logger(HlaboratoriesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      this.logger.log(`HLabs: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `HLabs scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? HLABORATORIES_DEFAULT_TIMEOUT_SECONDS,
    });

    const companyUrl = input.companyUrl || HLABORATORIES_ORIGIN;
    const origin = this.resolveOrigin(companyUrl);
    const apiUrl = `${origin.replace(/\/$/, '')}${HLABORATORIES_ROLES_PATH}`;
    const careersUrl = `${origin.replace(/\/$/, '')}/jobs`;

    const response = await client.get<HlaboratoriesRole[]>(apiUrl);
    const roles = Array.isArray(response.data) ? response.data : [];

    const jobs: JobPostDto[] = [];
    const seen = new Set<string>();

    for (const role of roles) {
      if (!role || role.is_open === false || !role.title) {
        continue;
      }

      const id = `hlaboratories-${role.id}`;
      if (seen.has(id) || !id) {
        continue;
      }
      seen.add(id);

      const { jobTypes, employmentType } = this.buildJobTypes(role.employment_type);
      const { isRemote, workFromHomeType } = this.parseWorkplace(role.remote);
      const location = this.parseLocation(role.location);

      const job = new JobPostDto({
        id,
        site: Site.HLABORATORIES,
        title: this.normalize(role.title),
        companyName: HLABORATORIES_COMPANY_NAME,
        companyUrl,
        jobUrl: careersUrl,
        jobUrlDirect: careersUrl,
        applyUrl: careersUrl,
        description: this.buildDescription(role.description, role.requirements),
        location,
        isRemote,
        workFromHomeType,
        jobType: jobTypes,
        employmentType,
        datePosted: toDateOnly(role.created_at),
        department: role.department ? this.normalize(role.department) : null,
      });

      jobs.push(job);
    }

    return jobs;
  }

  private resolveOrigin(companyUrl: string): string {
    try {
      return new URL(companyUrl).origin;
    } catch {
      return HLABORATORIES_ORIGIN;
    }
  }

  private buildDescription(description: string | null | undefined, requirements: string | null | undefined): string | null {
    const desc = this.normalize(description);
    const reqs = this.normalize(requirements);
    if (!desc && !reqs) return null;
    if (!desc) return reqs;
    if (!reqs) return desc;
    return `${desc}\n\n## Requirements\n\n${reqs}`;
  }

  private buildJobTypes(employmentType: string | null | undefined): {
    jobTypes: JobType[];
    employmentType: string;
  } {
    const out: JobType[] = [];
    if (employmentType) {
      const normalized = this.normalize(employmentType).replace(/[\s_\-/]+/g, '').toLowerCase();
      const jobType = getJobTypeFromString(normalized);
      if (jobType) {
        out.push(jobType);
      }
    }
    if (out.length === 0) {
      out.push(JobType.FULL_TIME);
    }
    return { jobTypes: out, employmentType: this.jobTypeLabel(out[0]) };
  }

  private jobTypeLabel(jobType: JobType): string {
    switch (jobType) {
      case JobType.FULL_TIME:
        return 'Full time';
      case JobType.PART_TIME:
        return 'Part time';
      case JobType.CONTRACT:
        return 'Contract';
      case JobType.TEMPORARY:
        return 'Temporary';
      case JobType.INTERNSHIP:
        return 'Internship';
      case JobType.PER_DIEM:
        return 'Per diem';
      case JobType.NIGHTS:
        return 'Nights';
      case JobType.OTHER:
        return 'Other';
      case JobType.SUMMER:
        return 'Summer';
      case JobType.VOLUNTEER:
        return 'Volunteer';
      case JobType.PERMANENT:
        return 'Permanent';
      case JobType.APPRENTICESHIP:
        return 'Apprenticeship';
      default:
        return 'Full time';
    }
  }

  private parseWorkplace(remote: boolean | null | undefined): {
    isRemote: boolean;
    workFromHomeType: string | null;
  } {
    return remote === true
      ? { isRemote: true, workFromHomeType: 'Remote' }
      : { isRemote: false, workFromHomeType: 'On Site' };
  }

  private parseLocation(text: string | null | undefined): LocationDto | null {
    if (!text) {
      return null;
    }
    const normalized = this.normalize(text);
    const match = normalized.match(/^([^,]+?)\s*,\s*([A-Za-z]{2})\b/);
    if (match) {
      return new LocationDto({
        city: this.toTitleCase(match[1]),
        state: match[2].toUpperCase(),
        country: Country.USA,
      });
    }
    return new LocationDto({ city: normalized, country: Country.USA });
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

    if (input.isRemote === true) {
      filtered = filtered.filter((job) => job.isRemote === true);
    }

    if (input.jobType) {
      filtered = filtered.filter((job) =>
        job.jobType?.includes(input.jobType as JobType),
      );
    }

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(input.resultsWanted, HLABORATORIES_DEFAULT_RESULTS);
    return filtered.slice(offset, offset + requested);
  }

  private toTitleCase(value: string): string {
    return value
      .toLowerCase()
      .split(/([\s\-]+)/)
      .map((part) => (part.match(/^[\s\-]+$/) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('');
  }

  private normalize(value: unknown): string {
    return typeof value === 'string'
      ? value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  private errorLabel(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return 'unknown error';
    }
    const status = (error as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number') {
      return `HTTP ${status}`;
    }
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
