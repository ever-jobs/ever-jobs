import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, extractJobType, parseLocationText } from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import {
  XLIGHT_APPLY_SELECTOR,
  XLIGHT_CAREERS_URL,
  XLIGHT_COMPANY_NAME,
  XLIGHT_DEFAULT_TIMEOUT_SECONDS,
  XLIGHT_ITEM_SELECTOR,
  XLIGHT_LABEL_SELECTOR,
  XLIGHT_LINKEDIN_JOB_RE,
  XLIGHT_ORIGIN,
  XLIGHT_TITLE_SELECTOR,
} from './xlight.constants';
import { XlightJobRow } from './xlight.types';

@SourcePlugin({
  site: Site.XLIGHT,
  name: XLIGHT_COMPANY_NAME,
  category: 'company',
  companyDomains: ['xlight.com'],
})
@Injectable()
export class XlightService implements IScraper {
  private readonly logger = new Logger(XlightService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job cards in the xLight careers list'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`xLight: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`xLight scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? XLIGHT_DEFAULT_TIMEOUT_SECONDS,
    });

    const careersUrl = this.normalize(input.companyUrl) || XLIGHT_CAREERS_URL;
    const res = await client.get<string>(careersUrl);
    const rows = this.parseCareersPage(cheerio.load(String(res.data ?? '')));
    return rows
      .map((row) => this.toJobPost(row, careersUrl))
      .filter((job): job is JobPostDto => job !== null);
  }

  private parseCareersPage($: cheerio.CheerioAPI): XlightJobRow[] {
    const rows: XlightJobRow[] = [];
    $(XLIGHT_ITEM_SELECTOR).each((_i, el) => {
      const item = $(el);
      const title = this.normalize(item.find(XLIGHT_TITLE_SELECTOR).first().text());
      if (!title) return;
      const labels = item
        .find(XLIGHT_LABEL_SELECTOR)
        .map((_j, label) => this.normalize($(label).text()))
        .get()
        .filter((text) => text && text !== '|');
      const applyHref = this.normalize(item.find(XLIGHT_APPLY_SELECTOR).first().attr('href') ?? '');
      rows.push({ title, labels, applyHref });
    });
    return rows;
  }

  private toJobPost(row: XlightJobRow, careersUrl: string): JobPostDto | null {
    const linkedinId = XLIGHT_LINKEDIN_JOB_RE.exec(row.applyHref)?.[1] ?? null;
    const atsId = linkedinId ?? (this.slugFromTitle(row.title) || null);
    if (!atsId) return null;

    const { department, typeText, workModeText, locationText } = this.splitLabels(row.labels);
    const parsed = locationText ? parseLocationText(locationText) : null;
    const location = parsed?.location ?? null;
    const jobType = typeText ? extractJobType(typeText.replace(/-/g, ' ')) : null;
    const applyUrl = this.absoluteUrl(row.applyHref);

    return new JobPostDto({
      id: `xlight-${atsId}`,
      atsId,
      site: Site.XLIGHT,
      atsType: 'xlight',
      title: row.title,
      companyName: XLIGHT_COMPANY_NAME,
      companyUrl: XLIGHT_ORIGIN,
      jobUrl: careersUrl,
      jobUrlDirect: applyUrl ?? careersUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(department ? { department } : {}),
      jobType,
      ...(typeText ? { employmentType: typeText } : {}),
      ...(workModeText ? { workFromHomeType: workModeText } : {}),
      ...(applyUrl ? { applyUrl } : {}),
    });
  }

  /** labels look like ['Engineering', 'Full Time', 'Hybrid', 'Palo Alto']: dept | type | work mode | location. */
  private splitLabels(labels: string[]): {
    department: string;
    typeText: string;
    workModeText: string;
    locationText: string;
  } {
    const department = labels[0] ?? '';
    const locationText = labels.length > 1 ? labels[labels.length - 1] : '';
    let typeText = '';
    let workModeText = '';
    for (const label of labels.slice(1, -1)) {
      const lower = label.toLowerCase();
      if (/^(remote|hybrid|on[\s-]?site)/.test(lower)) {
        workModeText = lower.startsWith('on') ? 'On Site' : label;
      } else if (!typeText) {
        typeText = label;
      }
    }
    return { department, typeText, workModeText, locationText };
  }

  private absoluteUrl(href: string): string | null {
    if (!href) return null;
    try {
      return new URL(href, XLIGHT_ORIGIN).toString();
    } catch {
      return null;
    }
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.department].some((value) =>
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
