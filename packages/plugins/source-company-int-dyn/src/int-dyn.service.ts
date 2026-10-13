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
import { createHttpClient } from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import {
  INT_DYN_APPLY_MAILTO,
  INT_DYN_BULLET_SELECTOR,
  INT_DYN_CAREERS_URL,
  INT_DYN_COMPANY_NAME,
  INT_DYN_DEFAULT_TIMEOUT_SECONDS,
  INT_DYN_ITEM_SELECTOR,
  INT_DYN_ORIGIN,
  INT_DYN_SECTION_SELECTOR,
  INT_DYN_TAGLINE_SELECTOR,
  INT_DYN_TITLE_SELECTOR,
} from './int-dyn.constants';
import { IntDynJobRow } from './int-dyn.types';

@SourcePlugin({
  site: Site.INT_DYN,
  name: INT_DYN_COMPANY_NAME,
  category: 'company',
  companyDomains: ['int-dyn.com'],
})
@Injectable()
export class IntDynService implements IScraper {
  private readonly logger = new Logger(IntDynService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job cards in the Integrated Dynamics careers section'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Integrated Dynamics: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Integrated Dynamics scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? INT_DYN_DEFAULT_TIMEOUT_SECONDS,
    });

    const careersUrl = this.pageUrl(this.normalize(input.companyUrl)) || INT_DYN_ORIGIN;
    const res = await client.get<string>(careersUrl);
    const rows = this.parseCareersPage(cheerio.load(String(res.data ?? '')));
    return rows
      .map((row) => this.toJobPost(row))
      .filter((job): job is JobPostDto => job !== null);
  }

  private parseCareersPage($: cheerio.CheerioAPI): IntDynJobRow[] {
    const rows: IntDynJobRow[] = [];
    const section = $(INT_DYN_SECTION_SELECTOR).first();
    if (!section.length) return rows;
    section.find(INT_DYN_ITEM_SELECTOR).each((_i, el) => {
      const item = $(el);
      const title = this.normalize(item.find(INT_DYN_TITLE_SELECTOR).first().text());
      if (!title) return;
      const tagline = this.normalize(item.find(INT_DYN_TAGLINE_SELECTOR).first().text());
      const bullets = item
        .find(INT_DYN_BULLET_SELECTOR)
        .map((_j, li) => this.normalize($(li).text()))
        .get()
        .filter(Boolean);
      rows.push({ title, tagline, bullets });
    });
    return rows;
  }

  private toJobPost(row: IntDynJobRow): JobPostDto | null {
    const atsId = this.slugFromTitle(row.title);
    if (!atsId) return null;
    const description = this.composeDescription(row);

    return new JobPostDto({
      id: `int-dyn-${atsId}`,
      atsId,
      site: Site.INT_DYN,
      atsType: 'int-dyn',
      title: row.title,
      companyName: INT_DYN_COMPANY_NAME,
      companyUrl: INT_DYN_ORIGIN,
      jobUrl: INT_DYN_CAREERS_URL,
      jobUrlDirect: INT_DYN_CAREERS_URL,
      applyUrl: INT_DYN_APPLY_MAILTO,
      jobType: null,
      ...(description ? { description } : {}),
    });
  }

  private composeDescription(row: IntDynJobRow): string {
    const parts: string[] = [];
    if (row.tagline) parts.push(row.tagline);
    if (row.bullets.length) parts.push(row.bullets.map((b) => `- ${b}`).join('\n'));
    return parts.join('\n\n');
  }

  /** The careers board lives at the #Careers anchor of the one-page site; strip the fragment for the fetch. */
  private pageUrl(url: string): string {
    if (!url) return '';
    try {
      const u = new URL(url);
      u.hash = '';
      return u.toString();
    } catch {
      return '';
    }
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.department, job.description].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
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
