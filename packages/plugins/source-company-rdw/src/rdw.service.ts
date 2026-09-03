import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  BrowserPool,
  extractLdJsonBlocks,
  JobPostingLd,
  markdownConverter,
  parseJobPostingLd,
  parseLocationList,
} from '@ever-jobs/common';
import type { Page } from 'playwright';
import {
  RDW_CAREERS_URL,
  RDW_COMPANY_NAME,
  RDW_DEFAULT_RESULTS,
  RDW_DEFAULT_TIMEOUT_SECONDS,
  RDW_ORIGIN,
  RDW_SEARCH_PATH,
} from './rdw.constants';
import { RdwJobCard } from './rdw.types';

@SourcePlugin({
  site: Site.RDW,
  name: 'Redwire Corporation',
  category: 'company',
  companyDomains: ['rdw.com', 'redwirespace.com'],
})
@Injectable()
export class RdwService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(RdwService.name);

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      this.logger.log(`RDW: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `RDW scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const proxy = input.proxies?.[0];
    const timeoutMs =
      (input.requestTimeout ?? RDW_DEFAULT_TIMEOUT_SECONDS) * 1000;

    const page = await BrowserPool.getPage({
      proxy,
      stealth: true,
      headful: true,
    });

    try {
      const jobs: JobPostDto[] = [];
      const seen = new Set<string>();
      let pageNum = 1;

      while (true) {
        const searchUrl = this.searchUrl(input, pageNum);
        const searchHtml = await this.fetchHtml(searchUrl, page, timeoutMs);
        const { cards, hasNext } = this.parseSearchPage(searchHtml);

        if (cards.length === 0) {
          break;
        }

        const allSeen = cards.every((card) => seen.has(card.detailUrl));
        if (allSeen) {
          break;
        }

        for (const card of cards) {
          if (seen.has(card.detailUrl)) {
            continue;
          }
          seen.add(card.detailUrl);

          const detailHtml = await this.fetchHtml(
            card.detailUrl,
            page,
            timeoutMs,
          );
          jobs.push(this.toJobPost(card, detailHtml));
        }

        if (!hasNext) {
          break;
        }
        pageNum++;
      }

      return jobs;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  protected async fetchHtml(
    url: string,
    page?: Page,
    timeoutMs?: number,
  ): Promise<string> {
    const timeout = timeoutMs ?? RDW_DEFAULT_TIMEOUT_SECONDS * 1000;

    if (page) {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      return page.content();
    }

    const p = await BrowserPool.getPage({ stealth: true, headful: true });
    try {
      await p.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      return p.content();
    } finally {
      await p.close().catch(() => undefined);
    }
  }

  private searchUrl(input: ScraperInputDto, pageNum: number): string {
    const baseUrl =
      input.companyUrl || `${RDW_ORIGIN}${RDW_SEARCH_PATH}`;
    return this.withPage(baseUrl, pageNum);
  }

  private withPage(url: string, pageNum: number): string {
    if (pageNum === 1) {
      return url;
    }
    const [base, search] = url.split('?');
    const params = new URLSearchParams(search || '');
    params.set('page', String(pageNum));
    return `${base}?${params.toString()}`;
  }

  private parseSearchPage(html: string): {
    cards: RdwJobCard[];
    hasNext: boolean;
  } {
    const $ = cheerio.load(html);
    const cards: RdwJobCard[] = [];

    $('article.col-12.job-search-results-card-col').each((_i, el) => {
      const card = $(el);
      const titleLink = card
        .find('h3.card-title.job-search-results-card-title a')
        .first();
      const title = this.normalize(titleLink.text());
      const href = titleLink.attr('href')?.trim() ?? '';
      const detailUrl = this.resolveUrl(href, RDW_ORIGIN);

      if (!title || !detailUrl) {
        return;
      }

      const workplaceEl = card.find('.job-component-workplace-type span').first();
      const workplaceTypeText = this.normalize(workplaceEl.text()) || null;
      const workplaceTypeValue =
        workplaceEl.attr('data-value')?.trim().toLowerCase() ||
        this.inferWorkplaceValue(workplaceTypeText ?? '') ||
        null;

      cards.push({
        title,
        detailUrl,
        requisitionId:
          this.normalize(
            card.find('.job-component-requisition-identifier span').text(),
          ) || null,
        workplaceTypeText,
        workplaceTypeValue,
        locationText:
          this.normalize(card.find('.job-component-location span').text()) ||
          null,
        department:
          this.normalize(card.find('.job-component-department span').text()) ||
          null,
        summary:
          this.normalize(card.find('p.job-search-results-summary').text()) ||
          null,
      });
    });

    const hasNext = this.hasNextPage($);
    return { cards, hasNext };
  }

  private hasNextPage($: cheerio.CheerioAPI): boolean {
    const navText = this.normalize(
      $('nav[aria-label="Pagination"]').text() || '',
    );
    const match = navText.match(
      /Displaying\s+\d+\s*-\s*(\d+)\s*of\s*(\d+)/i,
    );
    if (match) {
      const end = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      return !Number.isNaN(end) && !Number.isNaN(total) && end < total;
    }

    // Fallback: any pagination link points to a later page.
    const currentPage = this.currentPageFromUrl($('a[aria-current="page"]').attr('href') ?? '');
    let nextPageFound = false;
    $('nav[aria-label="Pagination"] a[href^="/jobs/search?page="]').each(
      (_i, el) => {
        const page = this.currentPageFromUrl(
          $(el).attr('href') ?? '',
        );
        if (page > currentPage) {
          nextPageFound = true;
          return false;
        }
      },
    );
    return nextPageFound;
  }

  private currentPageFromUrl(href: string): number {
    const match = /page=(\d+)/.exec(href);
    return match ? parseInt(match[1], 10) : 1;
  }

  private toJobPost(card: RdwJobCard, detailHtml: string): JobPostDto {
    const ld = parseJobPostingLd(detailHtml)[0] ?? null;
    const title = this.normalize(ld?.title ?? card.title);
    const {
      cleanTitle,
      prefixJobType,
      workFromHomeType: prefixWorkFromHomeType,
    } = this.parseTitlePrefix(title);

    const employmentType = this.normalize(ld?.employmentType ?? '') || null;
    const jobType =
      prefixJobType ??
      (employmentType ? this.jobTypeFromEmploymentType(employmentType) : null);

    const { location, isRemote, workFromHomeType } = this.buildLocation(
      ld,
      card,
      prefixWorkFromHomeType,
    );

    const finalTitle = cleanTitle || title;
    const requisitionId = card.requisitionId || this.requisitionFromUrl(card.detailUrl);
    const clinchId = this.extractIdentifierValue(detailHtml);
    const id = requisitionId
      ? `rdw-${requisitionId}`
      : `rdw-${clinchId ?? this.slugFromUrl(card.detailUrl)}`;

    const rawDescription = this.normalize(ld?.description ?? card.summary ?? '');
    const description = rawDescription ? markdownConverter(rawDescription) : null;

    const datePosted = ld?.datePosted ? new Date(ld.datePosted) : null;

    return new JobPostDto({
      id,
      site: Site.RDW,
      title: finalTitle,
      companyName: RDW_COMPANY_NAME,
      companyUrl: RDW_CAREERS_URL,
      jobUrl: card.detailUrl,
      applyUrl: card.detailUrl,
      location,
      description,
      isRemote,
      datePosted,
      department: card.department ?? undefined,
      employmentType: employmentType ?? undefined,
      workFromHomeType: workFromHomeType ?? undefined,
      atsId: requisitionId ?? undefined,
      ...(jobType ? { jobType: [jobType] } : {}),
      emails: [],
    });
  }

  private parseTitlePrefix(title: string): {
    cleanTitle: string;
    prefixJobType: JobType | null;
    workFromHomeType: string | null;
  } {
    const match = /^(Contractor|Contract|Temporary|Internship|Intern|Hybrid|Remote|On[- ]?Site)\s*[,–—-]?\s+/i.exec(
      title,
    );
    if (!match) {
      return { cleanTitle: title, prefixJobType: null, workFromHomeType: null };
    }

    const prefix = match[1].trim();
    const cleanTitle = title.slice(match[0].length).trim();
    const normalized = prefix.toLowerCase().replace(/[\s-]/g, '');

    let prefixJobType: JobType | null = null;
    let workFromHomeType: string | null = null;

    if (normalized === 'contract' || normalized === 'contractor') {
      prefixJobType = JobType.CONTRACT;
    } else if (normalized === 'temporary') {
      prefixJobType = JobType.TEMPORARY;
    } else if (normalized === 'intern' || normalized === 'internship') {
      prefixJobType = JobType.INTERNSHIP;
    } else if (normalized === 'hybrid') {
      workFromHomeType = 'Hybrid';
    } else if (normalized === 'remote') {
      workFromHomeType = 'Remote';
    } else if (normalized === 'onsite' || normalized === 'onsite') {
      workFromHomeType = 'On Site';
    }

    return { cleanTitle, prefixJobType, workFromHomeType };
  }

  private jobTypeFromEmploymentType(value: string): JobType | null {
    const normalized = value.replace(/[\s_]+/g, '').toLowerCase();
    return getJobTypeFromString(normalized);
  }

  private buildLocation(
    ld: JobPostingLd | null,
    card: RdwJobCard,
    prefixWorkFromHomeType: string | null,
  ): {
    location: LocationDto | null;
    isRemote: boolean;
    workFromHomeType: string | null;
  } {
    const cardWorkplaceText = (card.workplaceTypeText ?? '').toLowerCase();
    const cardWorkplaceValue = (card.workplaceTypeValue ?? '').toLowerCase();

    let workFromHomeType = prefixWorkFromHomeType;
    if (workFromHomeType === null) {
      if (
        cardWorkplaceValue === 'remote' ||
        /\bremote\b/i.test(cardWorkplaceText)
      ) {
        workFromHomeType = 'Remote';
      } else if (
        cardWorkplaceValue === 'hybrid' ||
        /\bhybrid\b/i.test(cardWorkplaceText)
      ) {
        workFromHomeType = 'Hybrid';
      } else if (
        cardWorkplaceValue === 'on_site' ||
        /\bon[- ]?site\b/i.test(cardWorkplaceText)
      ) {
        workFromHomeType = 'On Site';
      }
    }

    const isRemote =
      /\bremote\b/i.test(workFromHomeType ?? '') || (ld?.remote ?? false);

    const ldLocation = ld?.locations?.[0];
    if (ldLocation) {
      const location = this.locationFromLd(ldLocation, isRemote);
      return { location, isRemote, workFromHomeType };
    }

    if (card.locationText) {
      const parsed = parseLocationList([card.locationText]);
      const parsedWfh =
        workFromHomeType ?? (parsed.workFromHomeType || null);
      return {
        location: parsed.location,
        isRemote: parsed.remoteMentioned || isRemote,
        workFromHomeType: parsedWfh,
      };
    }

    return { location: null, isRemote, workFromHomeType };
  }

  private locationFromLd(
    loc: NonNullable<JobPostingLd['locations']>[number],
    isRemote: boolean,
  ): LocationDto | null {
    const country = loc.country?.trim() ?? '';
    const region = loc.region?.trim() ?? '';
    const city = loc.city?.trim() ?? '';

    const isLdRemote =
      region.toLowerCase() === 'remote' ||
      (isRemote && !city && !region && !country);

    if (isLdRemote) {
      return new LocationDto({
        city: 'Remote',
        country: country.length === 2 ? country : 'US',
      });
    }

    const isUs =
      country === 'US' || country === 'USA' || country === 'United States';

    if (isUs) {
      if (city && region) {
        const parsed = parseLocationList([
          `${city}, ${region}, United States`,
        ]);
        if (parsed.location?.state) {
          return parsed.location;
        }
      }
      if (city) {
        return new LocationDto({ city, country: 'United States' });
      }
      if (region) {
        return new LocationDto({ state: region, country: 'United States' });
      }
      return new LocationDto({ country: 'United States' });
    }

    if (city) {
      return new LocationDto({ city, country: country || undefined });
    }
    if (country) {
      return new LocationDto({ country });
    }
    return null;
  }

  private extractIdentifierValue(detailHtml: string): string | null {
    for (const block of extractLdJsonBlocks(detailHtml)) {
      const posting = this.findJobPostingNode(block);
      if (!posting || typeof posting !== 'object') {
        continue;
      }
      const identifier = (posting as Record<string, unknown>).identifier;
      if (identifier && typeof identifier === 'object') {
        const value = (identifier as Record<string, unknown>).value;
        if (typeof value === 'string' && value) {
          return value;
        }
      }
      if (typeof identifier === 'string' && identifier) {
        return identifier;
      }
    }
    return null;
  }

  private findJobPostingNode(value: unknown): unknown {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findJobPostingNode(item);
        if (found) {
          return found;
        }
      }
      return null;
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const node = value as Record<string, unknown>;
    const type = node['@type'];
    if (
      type === 'JobPosting' ||
      (Array.isArray(type) && type.includes('JobPosting'))
    ) {
      return node;
    }

    if (Array.isArray(node['@graph'])) {
      const found = this.findJobPostingNode(node['@graph']);
      if (found) {
        return found;
      }
    }

    if (Array.isArray(node.itemListElement)) {
      const found = this.findJobPostingNode(node.itemListElement);
      if (found) {
        return found;
      }
    }

    return null;
  }

  private requisitionFromUrl(url: string): string | null {
    const match = /\/jobs\/[^/]+-(\d+)$/.exec(url);
    return match?.[1] ?? null;
  }

  private resolveUrl(href: string, origin: string): string {
    href = href.trim();
    if (!href) {
      return '';
    }
    if (/^https?:\/\//i.test(href)) {
      return href;
    }
    if (href.startsWith('/')) {
      return `${origin}${href}`;
    }
    return `${origin}/${href}`;
  }

  private inferWorkplaceValue(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('remote')) {
      return 'remote';
    }
    if (lower.includes('hybrid')) {
      return 'hybrid';
    }
    if (/\bon[- ]?site\b/i.test(text)) {
      return 'on_site';
    }
    return '';
  }

  private applyInput(
    jobs: JobPostDto[],
    input: ScraperInputDto,
  ): JobPostDto[] {
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
    const requested = this.nonNegativeInt(
      input.resultsWanted,
      RDW_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromUrl(url: string): string {
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    return (
      path.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'role'
    );
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
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === 'number') {
      return `HTTP ${status}`;
    }
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
