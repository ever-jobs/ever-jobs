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
import { createHttpClient, describeUrlForLog, parseLocationText, pinUrlToHosts } from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import {
  GETMAXSPACE_ALLOWED_HOSTS,
  GETMAXSPACE_CAREERS_URL,
  GETMAXSPACE_COL_SELECTOR,
  GETMAXSPACE_COMPANY_NAME,
  GETMAXSPACE_DEFAULT_TIMEOUT_SECONDS,
  GETMAXSPACE_ITEM_SELECTOR,
  GETMAXSPACE_ORIGIN,
} from './getmaxspace.constants';
import { GetMaxSpaceJobRow } from './getmaxspace.types';

@SourcePlugin({
  site: Site.GETMAXSPACE,
  name: 'Max Space',
  category: 'company',
  companyDomains: ['getmaxspace.com'],
})
@Injectable()
export class GetMaxSpaceService implements IScraper {
  private readonly logger = new Logger(GetMaxSpaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job items on the Max Space careers page'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Max Space: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Max Space scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? GETMAXSPACE_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: GETMAXSPACE_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const res = await client.get<string>(careersUrl);
    const rows = this.parseCareersPage(cheerio.load(String(res.data ?? '')));
    return rows
      .map((row) => this.toJobPost(row))
      .filter((job): job is JobPostDto => job !== null);
  }

  /**
   * The careers page to fetch: the caller's `companyUrl` when it is on
   * getmaxspace.com (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return GETMAXSPACE_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, GETMAXSPACE_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Max Space: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${GETMAXSPACE_ALLOWED_HOSTS.join(', ')}`,
      );
      return GETMAXSPACE_CAREERS_URL;
    }
    return pinned;
  }

  private parseCareersPage($: cheerio.CheerioAPI): GetMaxSpaceJobRow[] {
    const rows: GetMaxSpaceJobRow[] = [];
    $(GETMAXSPACE_ITEM_SELECTOR).each((_i, el) => {
      const anchor = $(el);
      const href = this.decodeEntities(anchor.attr('href') ?? '');
      if (!href) return;
      const col = (idx: number) =>
        this.normalize(anchor.find(GETMAXSPACE_COL_SELECTOR).eq(idx).text());
      const title = col(0);
      if (!title) return;
      rows.push({
        title,
        department: col(1),
        employmentType: col(2),
        location: col(3),
        href,
      });
    });
    return rows;
  }

  private toJobPost(row: GetMaxSpaceJobRow): JobPostDto | null {
    const atsId = this.indeedJobId(row.href) ?? this.slugFromTitle(row.title);
    const parsed = row.location ? parseLocationText(row.location) : null;
    const location = parsed?.location ?? null;
    const jobUrl = this.normalizeUrl(row.href);

    return new JobPostDto({
      id: `getmaxspace-${atsId}`,
      atsId,
      site: Site.GETMAXSPACE,
      atsType: 'getmaxspace',
      title: row.title,
      companyName: GETMAXSPACE_COMPANY_NAME,
      companyUrl: GETMAXSPACE_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(row.department ? { department: row.department } : {}),
      jobType: null,
      ...(row.employmentType ? { employmentType: row.employmentType } : {}),
    });
  }

  /** Hex id from `/job/{slug}-{hex}` or the `jk` param of `/viewjob`. */
  private indeedJobId(href: string): string | null {
    const jobPath = /indeed\.com\/job\/[a-z0-9-]*-([a-z0-9]{8,})/i.exec(href);
    if (jobPath) return jobPath[1];
    const jk = /[?&]jk=([a-z0-9]{8,})/i.exec(href);
    if (jk) return jk[1];
    return null;
  }

  private normalizeUrl(href: string): string {
    try {
      const u = new URL(href);
      return u.origin + u.pathname + u.search;
    } catch {
      return href;
    }
  }

  private decodeEntities(text: string): string {
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
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
