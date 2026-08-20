import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, CompensationDto, Country, DescriptionFormat, Site,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient, NaukriException, markdownConverter, extractEmails, randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import { NAUKRI_HEADERS } from './naukri.constants';

@SourcePlugin({
  site: Site.NAUKRI,
  name: 'Naukri',
  category: 'regional',
})
@Injectable()
export class NaukriService implements IScraper {
  private readonly logger = new Logger(NaukriService.name);
  private readonly baseUrl = 'https://www.naukri.com/jobapi/v3/search';
  private readonly jobsPerPage = 20;
  private readonly delay = 3;
  private readonly bandDelay = 4;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(NAUKRI_HEADERS);

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    const seenIds = new Set<string>();
    let page = Math.floor((input.offset ?? 0) / this.jobsPerPage) + 1;

    while (jobList.length < resultsWanted && page <= 50) {
      this.logger.log(`Fetching Naukri jobs, page ${page}`);

      try {
        const searchTerm = input.searchTerm ?? '';
        const params: Record<string, any> = {
          noOfResults: this.jobsPerPage,
          urlType: 'search_by_keyword',
          searchType: 'adv',
          keyword: searchTerm,
          pageNo: page,
          k: searchTerm,
          seoKey: `${searchTerm.toLowerCase().replace(/\s+/g, '-')}-jobs`,
          src: 'jobsearchDesk',
          latLong: '',
        };
        if (input.location) params.location = input.location;
        if (input.isRemote) params.remote = 'true';
        if (input.hoursOld) params.days = Math.ceil(input.hoursOld / 24);

        const response = await client.get(this.baseUrl, { params });

        if (response.status < 200 || response.status >= 400) {
          this.logger.error(`Naukri API status ${response.status}`);
          break;
        }

        const jobDetails = response.data?.jobDetails ?? [];
        if (jobDetails.length === 0) break;

        for (const job of jobDetails) {
          if (jobList.length >= resultsWanted) break;
          const jobId = job.jobId;
          if (!jobId || seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const jobPost = this.processJob(job, jobId, input);
            if (jobPost) jobList.push(jobPost);
          } catch (err: any) {
            this.logger.warn(`Naukri process error for ${jobId}: ${err.message}`);
          }
        }

        page++;
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        this.logger.error(`Naukri scrape error: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    return new JobResponseDto(jobList.slice(0, resultsWanted), diagnostics);
  }

  private processJob(job: any, jobId: string, input: ScraperInputDto): JobPostDto | null {
    const title = job.title ?? 'N/A';
    const company = job.companyName ?? 'N/A';

    // Location
    const location = this.getLocation(job.placeholders ?? []);

    // Compensation (Indian salary format)
    const compensation = this.getCompensation(job.placeholders ?? []);

    // Date
    const datePosted = this.parseDate(job.footerPlaceholderLabel, job.createdDate);

    // URL
    const jobUrl = `https://www.naukri.com${job.jdURL ?? `/job/${jobId}`}`;

    // Description
    let description = job.jobDescription ?? null;
    if (description && input.descriptionFormat === DescriptionFormat.MARKDOWN) {
      description = markdownConverter(description) ?? description;
    }

    // Remote detection
    const remoteKeywords = ['remote', 'work from home', 'wfh'];
    const fullText = `${title} ${description ?? ''} ${location.displayLocation()}`.toLowerCase();
    const isRemote = remoteKeywords.some((kw) => fullText.includes(kw));

    // Work from home type
    const workFromHomeType = this.inferWorkFromHomeType(job.placeholders ?? [], title, description ?? '');

    // Skills
    const skills = job.tagsAndSkills
      ? job.tagsAndSkills.split(',').map((s: string) => s.trim())
      : null;

    return new JobPostDto({
      id: `nk-${jobId}`,
      title,
      companyName: company,
      companyUrl: job.staticUrl ? `https://www.naukri.com/${job.staticUrl}` : null,
      location,
      isRemote,
      datePosted: toDateOnly(datePosted),
      jobUrl,
      compensation,
      description,
      emails: extractEmails(description),
      companyLogo: job.logoPathV3 ?? job.logoPath ?? null,
      skills,
      experienceRange: job.experienceText ?? null,
      companyRating: job.ambitionBoxData?.AggregateRating ? parseFloat(job.ambitionBoxData.AggregateRating) : null,
      companyReviewsCount: job.ambitionBoxData?.ReviewsCount ?? null,
      vacancyCount: job.vacancy ?? null,
      workFromHomeType,
      site: Site.NAUKRI,
    });
  }

  private getLocation(placeholders: any[]): LocationDto {
    for (const p of placeholders) {
      if (p.type === 'location') {
        const parts = (p.label ?? '').split(', ');
        return new LocationDto({
          city: parts[0] || null,
          state: parts.length > 1 ? parts[1] : null,
          country: Country.INDIA,
        });
      }
    }
    return new LocationDto({ country: Country.INDIA });
  }

  private getCompensation(placeholders: any[]): CompensationDto | null {
    for (const p of placeholders) {
      if (p.type === 'salary') {
        const text = (p.label ?? '').trim();
        if (text === 'Not disclosed') return null;

        const match = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(Lacs|Lakh|Cr)/i);
        if (!match) return null;

        let minSalary = parseFloat(match[1]);
        let maxSalary = parseFloat(match[2]);
        const unit = match[3].toLowerCase();

        if (unit === 'lacs' || unit === 'lakh') {
          minSalary *= 100000;
          maxSalary *= 100000;
        } else if (unit === 'cr') {
          minSalary *= 10000000;
          maxSalary *= 10000000;
        }

        return new CompensationDto({
          minAmount: Math.round(minSalary),
          maxAmount: Math.round(maxSalary),
          currency: 'INR',
        });
      }
    }
    return null;
  }

  private parseDate(label: string | null, createdDate: number | null): Date | null {
    const now = new Date();
    if (!label) {
      if (createdDate) return new Date(createdDate);
      return null;
    }
    const lbl = label.toLowerCase();
    if (lbl.includes('today') || lbl.includes('just now') || lbl.includes('few hours')) {
      return now;
    }
    if (lbl.includes('ago')) {
      const match = lbl.match(/(\d+)\s*day/);
      if (match) {
        const days = parseInt(match[1], 10);
        return new Date(now.getTime() - days * 86400000);
      }
    }
    if (createdDate) return new Date(createdDate);
    return null;
  }

  private inferWorkFromHomeType(placeholders: any[], title: string, description: string): string | null {
    const locStr = (placeholders.find((p: any) => p.type === 'location')?.label ?? '').toLowerCase();
    const fullText = `${locStr} ${title.toLowerCase()} ${description.toLowerCase()}`;
    if (fullText.includes('hybrid')) return 'Hybrid';
    if (fullText.includes('remote')) return 'Remote';
    if (fullText.includes('work from office')) return 'Work from office';
    return null;
  }
}
