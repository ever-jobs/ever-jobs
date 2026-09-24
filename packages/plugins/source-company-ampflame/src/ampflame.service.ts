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
  AMPFLAME_ALLOWED_HOSTS,
  AMPFLAME_CAREERS_URL,
  AMPFLAME_CELL_SELECTOR,
  AMPFLAME_COMPANY_NAME,
  AMPFLAME_DEFAULT_TIMEOUT_SECONDS,
  AMPFLAME_ORIGIN,
  AMPFLAME_ROW_SELECTOR,
  AMPFLAME_TABLE_SELECTOR,
} from './ampflame.constants';
import { AmpflameJobRow } from './ampflame.types';

@SourcePlugin({
  site: Site.AMPFLAME,
  name: AMPFLAME_COMPANY_NAME,
  category: 'company',
  companyDomains: ['ampflame.com'],
})
@Injectable()
export class AmpflameService implements IScraper {
  private readonly logger = new Logger(AmpflameService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job rows in the Ampflame careers table'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Ampflame: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Ampflame scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? AMPFLAME_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: AMPFLAME_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const res = await client.get<string>(careersUrl);
    const rows = this.parseCareersPage(cheerio.load(String(res.data ?? '')));
    return rows
      .map((row) => this.toJobPost(row, careersUrl))
      .filter((job): job is JobPostDto => job !== null);
  }

  /**
   * The careers page to fetch: the caller's `companyUrl` when it is on
   * ampflame.com (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return AMPFLAME_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, AMPFLAME_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Ampflame: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${AMPFLAME_ALLOWED_HOSTS.join(', ')}`,
      );
      return AMPFLAME_CAREERS_URL;
    }
    return pinned;
  }

  private parseCareersPage($: cheerio.CheerioAPI): AmpflameJobRow[] {
    const rows: AmpflameJobRow[] = [];
    const table = $(AMPFLAME_TABLE_SELECTOR).first();
    if (!table.length) return rows;
    table.find(AMPFLAME_ROW_SELECTOR).each((_i, el) => {
      const row = $(el);
      const cells: Record<string, string> = {};
      row.find(AMPFLAME_CELL_SELECTOR).each((_j, cell) => {
        const label = this.normalize($(cell).attr('data-label')).toLowerCase();
        if (label) cells[label] = this.normalize($(cell).text());
      });
      const title = cells['position'];
      if (!title) return; // header row or malformed row
      const applyHref = this.normalize(
        row.find('span[role="cell"][data-label="Apply"] a').attr('href') ?? '',
      );
      rows.push({
        title,
        department: cells['department'] ?? '',
        location: cells['location'] ?? '',
        applyHref,
      });
    });
    return rows;
  }

  private toJobPost(row: AmpflameJobRow, careersUrl: string): JobPostDto | null {
    const atsId = `${this.slugFromTitle(row.title)}-${this.slugFromTitle(row.location) || 'remote'}`;
    const parsed = row.location ? parseLocationText(row.location) : null;
    const location = parsed?.location ?? null;
    const applyUrl = this.absoluteUrl(row.applyHref);

    return new JobPostDto({
      id: `ampflame-${atsId}`,
      atsId,
      site: Site.AMPFLAME,
      atsType: 'ampflame',
      title: row.title,
      companyName: AMPFLAME_COMPANY_NAME,
      companyUrl: AMPFLAME_ORIGIN,
      jobUrl: careersUrl,
      jobUrlDirect: careersUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(row.department ? { department: row.department } : {}),
      ...(applyUrl ? { applyUrl } : {}),
      jobType: null,
    });
  }

  private absoluteUrl(href: string): string | null {
    if (!href) return null;
    try {
      return new URL(href, AMPFLAME_ORIGIN).toString();
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
