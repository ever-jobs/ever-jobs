import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { FREELANCERCOM_API_URL, FREELANCERCOM_HEADERS, FREELANCERCOM_DEFAULT_RESULTS, FREELANCERCOM_MAX_RESULTS } from './freelancercom.constants';
import { FreelancerComResponse, FreelancerComProject } from './freelancercom.types';

@SourcePlugin({
  site: Site.FREELANCERCOM,
  name: 'Freelancer.com',
  category: 'freelance',
})
@Injectable()
export class FreelancerComService implements IScraper {
  private readonly logger = new Logger(FreelancerComService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = Math.min(
      input.resultsWanted ?? FREELANCERCOM_DEFAULT_RESULTS,
      FREELANCERCOM_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(FREELANCERCOM_HEADERS);

    const params: Record<string, string> = {
      compact: 'true',
      limit: String(resultsWanted),
      full_description: 'true',
    };

    if (input.searchTerm) {
      params.query = input.searchTerm;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${FREELANCERCOM_API_URL}?${queryString}`;

    this.logger.log(`Fetching Freelancer.com projects: ${FREELANCERCOM_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as FreelancerComResponse;

      const projects = data?.result?.projects ?? [];
      if (projects.length === 0) {
        this.logger.log('No Freelancer.com projects available');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Freelancer.com returned ${projects.length} projects (total: ${data?.result?.total_count ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const project of projects) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(project, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping Freelancer.com project ${project.id}: ${err.message}`);
        }
      }

      this.logger.log(`Freelancer.com returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Freelancer.com scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private mapJob(project: FreelancerComProject, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!project.title || !project.id) return null;

    const jobUrl = project.seo_url
      ? `https://www.freelancer.com/projects/${project.seo_url}`
      : `https://www.freelancer.com/projects/${project.id}`;

    let description: string | null = project.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    let compensation: CompensationDto | null = null;
    if (project.budget) {
      const isHourly = project.type === 'hourly';
      compensation = new CompensationDto({
        interval: isHourly ? CompensationInterval.HOURLY : CompensationInterval.YEARLY,
        minAmount: project.budget.minimum ?? null,
        maxAmount: project.budget.maximum ?? null,
        currency: project.currency?.code ?? 'USD',
      });
    }

    const location = new LocationDto({
      city: project.location?.city ?? null,
      country: project.location?.country?.name ?? null,
    });

    let datePosted: string | null = null;
    if (project.time_submitted) {
      try {
        datePosted = toDateOnly(project.time_submitted * 1000);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `freelancercom-${project.id}`,
      title: project.title,
      companyName: project.owner?.display_name ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: true,
      emails: extractEmails(description),
      site: Site.FREELANCERCOM,
    });
  }
}
