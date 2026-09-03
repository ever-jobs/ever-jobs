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
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { BrowserPool, markdownConverter } from '@ever-jobs/common';
import type { Page } from 'playwright';
import {
  TROSSENROBOTICS_ALLOWED_HOST,
  TROSSENROBOTICS_CAREERS_URL,
  TROSSENROBOTICS_COMPANY_NAME,
  TROSSENROBOTICS_DEFAULT_RESULTS,
  TROSSENROBOTICS_DEFAULT_TIMEOUT_SECONDS,
  TROSSENROBOTICS_DETAIL_READY_SECONDS,
  TROSSENROBOTICS_LIST_SELECTOR,
  TROSSENROBOTICS_ORIGIN,
  TROSSENROBOTICS_READY_TIMEOUT_SECONDS,
  isAllowedTrossenroboticsUrl,
} from './trossenrobotics.constants';
import { TrossenroboticsJobCard } from './trossenrobotics.types';

@SourcePlugin({
  site: Site.TROSSENROBOTICS,
  name: 'Trossen Robotics',
  category: 'company',
  companyDomains: ['trossenrobotics.com', 'www.trossenrobotics.com'],
})
@Injectable()
export class TrossenroboticsService
  implements IScraper, OnModuleDestroy
{
  private readonly logger = new Logger(TrossenroboticsService.name);

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      this.logger.log(`Trossen Robotics: scraped ${out.length} jobs`);
      // Spec 1683: a source that returns nothing still owes a reason.
      return new JobResponseDto(
        out,
        out.length
          ? undefined
          : new ScrapeDiagnostics(
              'empty',
              `no postings matched on ${TROSSENROBOTICS_CAREERS_URL}`,
            ),
      );
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Trossen Robotics scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const proxy = input.proxies?.[0];
    const timeoutMs =
      (input.requestTimeout ?? TROSSENROBOTICS_DEFAULT_TIMEOUT_SECONDS) * 1000;

    const page = await BrowserPool.getPage({
      proxy,
      stealth: true,
      headful: true,
    });

    try {
      const startUrl = this.startUrl(input);
      const listHtml = await this.fetchHtml(
        startUrl,
        page,
        timeoutMs,
        TROSSENROBOTICS_LIST_SELECTOR,
      );
      const cards = this.parseListPage(listHtml);
      const jobs: JobPostDto[] = [];
      const seen = new Set<string>();
      let attempted = 0;
      let failed = 0;

      for (const card of cards) {
        if (seen.has(card.detailUrl)) {
          continue;
        }
        seen.add(card.detailUrl);

        if (!isAllowedTrossenroboticsUrl(card.detailUrl)) {
          this.logger.warn(
            `Trossen Robotics: skipping off-site job link \`${card.detailUrl}\` — not on ${TROSSENROBOTICS_ALLOWED_HOST}`,
          );
          continue;
        }

        attempted += 1;
        try {
          const detailHtml = await this.fetchHtml(
            card.detailUrl,
            page,
            timeoutMs,
          );
          jobs.push(this.toJobPost(card, detailHtml));
        } catch (error: unknown) {
          // One unreachable detail page must not discard the rest of the board.
          failed += 1;
          this.logger.warn(
            `Trossen Robotics: detail fetch failed for ${card.detailUrl}: ${this.errorLabel(error)}`,
          );
        }
      }

      if (failed > 0) {
        this.logger.warn(
          `Trossen Robotics: ${failed} of ${attempted} detail requests failed`,
        );
      }

      return jobs;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * The careers URL to start from: the caller's `companyUrl` when it is on
   * Trossen's own domain, otherwise this plugin's careers page.
   *
   * A company plugin exists to scrape one company, so an off-domain
   * `companyUrl` is either a mistake or an attempt to aim the browser
   * elsewhere. Neither deserves a failed scrape — ignore it and say so.
   */
  private startUrl(input: ScraperInputDto): string {
    const requested = input.companyUrl?.trim();
    if (!requested) {
      return TROSSENROBOTICS_CAREERS_URL;
    }
    if (!isAllowedTrossenroboticsUrl(requested)) {
      this.logger.warn(
        `Trossen Robotics: ignoring companyUrl \`${requested}\` — not on ${TROSSENROBOTICS_ALLOWED_HOST}`,
      );
      return TROSSENROBOTICS_CAREERS_URL;
    }
    return requested;
  }

  protected async fetchHtml(
    url: string,
    page?: Page,
    timeoutMs?: number,
    waitSelector?: string,
  ): Promise<string> {
    const timeout = timeoutMs ?? TROSSENROBOTICS_DEFAULT_TIMEOUT_SECONDS * 1000;

    if (page) {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      const ready = waitSelector ?? 'main section';
      await page
        .waitForSelector(ready, {
          timeout: TROSSENROBOTICS_READY_TIMEOUT_SECONDS * 1000,
        })
        .catch(() => undefined);
      return page.content();
    }

    const p = await BrowserPool.getPage({ stealth: true, headful: true });
    try {
      await p.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      const ready = waitSelector ?? 'main section';
      await p
        .waitForSelector(ready, {
          timeout: TROSSENROBOTICS_DETAIL_READY_SECONDS * 1000,
        })
        .catch(() => undefined);
      return p.content();
    } finally {
      await p.close().catch(() => undefined);
    }
  }

  private parseListPage(html: string): TrossenroboticsJobCard[] {
    const $ = cheerio.load(html);
    const cards: TrossenroboticsJobCard[] = [];

    $('section, [data-block-level-container="ClassicSection"]').each(
      (_i, el) => {
        const section = $(el);
        const link = section
          .find('a[aria-label="Learn More and Apply"]')
          .first();
        const href = link.attr('href')?.trim() ?? '';
        const detailUrl = this.resolveUrl(href, TROSSENROBOTICS_ORIGIN);
        const title = this.normalize(section.find('h2').first().text());

        if (!title || !detailUrl) {
          return;
        }

        const metaText = this.extractMetaText($, section);
        const { dateText, employmentType, workplaceType } =
          this.parseMetaText(metaText);

        cards.push({
          title,
          detailUrl,
          dateText,
          employmentType,
          workplaceType,
        });
      },
    );

    return cards;
  }

  private extractMetaText(
    $: cheerio.CheerioAPI,
    section: cheerio.Cheerio<any>,
  ): string {
    const title = this.normalize(section.find('h2').first().text());

    const candidate = section
      .find('p, div, span, li')
      .filter((_i, el) => {
        const $el = $(el);
        if ($el.closest('a').length) {
          return false;
        }
        const text = this.normalize($el.text());
        return (
          text.length > 0 &&
          text !== title &&
          (text.includes('|') || this.isMetaToken(text))
        );
      })
      .first()
      .text();

    return this.normalize(candidate);
  }

  private isMetaToken(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(lower) ||
      /^ongoing$/.test(lower) ||
      /\b(full[- ]?time|part[- ]?time|contract|temporary|internship|intern|freelance|per[- ]?diem)\b/.test(
        lower,
      ) ||
      /\b(remote|hybrid|on[- ]?site|in[- ]?office)\b/.test(lower)
    );
  }

  private parseMetaText(meta: string): {
    dateText: string | null;
    employmentType: string | null;
    workplaceType: string | null;
  } {
    const text = this.normalize(meta);
    const dateMatch = text.match(/^Ongoing|\d{1,2}\/\d{1,2}\/\d{2,4}/i);
    const dateText = dateMatch ? dateMatch[0] : null;
    let rest = dateText ? text.slice(dateText.length).trim() : text;
    rest = rest.replace(/^\|\s*/, '');

    const parts = rest
      .split(/\s*\|\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    let employmentType: string | null = null;
    let workplaceType: string | null = null;

    for (const part of parts) {
      if (this.isJobType(part)) {
        if (!employmentType) {
          employmentType = part;
        } else {
          employmentType = `${employmentType} | ${part}`;
        }
      } else if (this.isWorkplaceType(part)) {
        workplaceType = part;
      }
    }

    if (!employmentType && parts.length === 1 && this.isJobType(parts[0])) {
      employmentType = parts[0];
    }

    return { dateText, employmentType, workplaceType };
  }

  private isJobType(text: string): boolean {
    return this.extractJobTypeTokens(text).length > 0;
  }

  private isWorkplaceType(text: string): boolean {
    return /\b(remote|hybrid|on[- ]?site|in[- ]?office)\b/i.test(text);
  }

  private extractJobTypeTokens(text: string): JobType[] {
    const out: JobType[] = [];
    const tokens = text.split(/\s*[&/,]\s*/).map((t) => t.trim());
    for (const token of tokens) {
      let normalized = token.toLowerCase().replace(/[\s-]/g, '');
      if (normalized === 'intern') {
        normalized = 'internship';
      }
      const jobType = getJobTypeFromString(normalized);
      if (jobType && !out.includes(jobType)) {
        out.push(jobType);
      }
    }
    return out;
  }

  private toJobPost(
    card: TrossenroboticsJobCard,
    detailHtml: string,
  ): JobPostDto {
    const $ = cheerio.load(detailHtml);
    const detailTitle = this.normalize($('h1').first().text());
    const rawTitle = detailTitle || card.title;
    const { cleanTitle, prefixJobType, prefixWorkFromHomeType } =
      this.parseTitlePrefix(rawTitle);

    const firstSection = $('main section').first();
    const detailMetaText = firstSection.length
      ? this.extractMetaText($, firstSection)
      : '';
    const detailMeta = detailMetaText
      ? this.parseMetaText(detailMetaText)
      : null;

    const dateText =
      this.extractDateText(detailHtml) ??
      detailMeta?.dateText ??
      card.dateText;
    const employmentType =
      detailMeta?.employmentType ?? card.employmentType;
    const workplaceType =
      detailMeta?.workplaceType ?? card.workplaceType;

    const jobTypes = this.buildJobTypes(
      employmentType,
      cleanTitle,
      prefixJobType,
    );
    const { isRemote, workFromHomeType } = this.buildWorkplace(
      workplaceType,
      prefixWorkFromHomeType,
    );
    const location = this.buildLocation(isRemote);

    const id = `trossenrobotics-${this.slugFromUrl(card.detailUrl)}`;

    return new JobPostDto({
      id,
      site: Site.TROSSENROBOTICS,
      title: cleanTitle,
      companyName: TROSSENROBOTICS_COMPANY_NAME,
      companyUrl: TROSSENROBOTICS_CAREERS_URL,
      jobUrl: card.detailUrl,
      applyUrl: card.detailUrl,
      location,
      description: this.extractDescription(detailHtml),
      isRemote,
      datePosted: this.parseDate(dateText),
      employmentType: employmentType ?? undefined,
      workFromHomeType: workFromHomeType ?? undefined,
      jobType: jobTypes,
      emails: [],
    });
  }

  private parseTitlePrefix(title: string): {
    cleanTitle: string;
    prefixJobType: JobType | null;
    prefixWorkFromHomeType: string | null;
  } {
    const match = /^(Contractor|Contract|Temporary|Internship|Intern|Hybrid|Remote|On[- ]?Site)\s*[,–—-]?\s+/i.exec(
      title,
    );
    if (!match) {
      return { cleanTitle: title, prefixJobType: null, prefixWorkFromHomeType: null };
    }

    const prefix = match[1].trim();
    const cleanTitle = title.slice(match[0].length).trim();
    const normalized = prefix.toLowerCase().replace(/[\s-]/g, '');

    let prefixJobType: JobType | null = null;
    let prefixWorkFromHomeType: string | null = null;

    if (normalized === 'contract' || normalized === 'contractor') {
      prefixJobType = JobType.CONTRACT;
    } else if (normalized === 'temporary') {
      prefixJobType = JobType.TEMPORARY;
    } else if (normalized === 'intern' || normalized === 'internship') {
      prefixJobType = JobType.INTERNSHIP;
    } else if (normalized === 'hybrid') {
      prefixWorkFromHomeType = 'Hybrid';
    } else if (normalized === 'remote') {
      prefixWorkFromHomeType = 'Remote';
    } else if (normalized === 'onsite') {
      prefixWorkFromHomeType = 'On Site';
    }

    return { cleanTitle, prefixJobType, prefixWorkFromHomeType };
  }

  private buildJobTypes(
    employmentType: string | null,
    title: string,
    prefixJobType: JobType | null,
  ): JobType[] {
    const out: JobType[] = [];

    if (prefixJobType) {
      out.push(prefixJobType);
    }

    if (employmentType) {
      for (const jobType of this.extractJobTypeTokens(employmentType)) {
        if (!out.includes(jobType)) {
          out.push(jobType);
        }
      }
    }

    if (/\bintern(?:ship)?\b/i.test(title)) {
      if (!out.includes(JobType.INTERNSHIP)) {
        out.push(JobType.INTERNSHIP);
      }
    }

    if (/\bcontract(?:or)?\b/i.test(title)) {
      if (!out.includes(JobType.CONTRACT)) {
        out.push(JobType.CONTRACT);
      }
    }

    return out;
  }

  private buildWorkplace(
    workplaceType: string | null,
    prefixWorkFromHomeType: string | null,
  ): { isRemote: boolean; workFromHomeType: string | null } {
    let workFromHomeType = prefixWorkFromHomeType;
    if (!workFromHomeType && workplaceType) {
      const lower = workplaceType.toLowerCase();
      if (lower.includes('remote')) {
        workFromHomeType = 'Remote';
      } else if (lower.includes('hybrid')) {
        workFromHomeType = 'Hybrid';
      } else if (/\bon[- ]?site\b/i.test(lower) || lower.includes('in office')) {
        workFromHomeType = 'On Site';
      }
    }

    const isRemote = /\bremote\b/i.test(workFromHomeType ?? '');
    return { isRemote, workFromHomeType };
  }

  private buildLocation(isRemote: boolean): LocationDto | null {
    if (isRemote) {
      return new LocationDto({ city: 'Remote' });
    }
    return null;
  }

  private extractDateText(html: string): string | null {
    const $ = cheerio.load(html);
    const text = this.normalize($('main').text() || $('body').text());
    const match = text.match(/Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    return match?.[1] ?? null;
  }

  private parseDate(text: string | null): Date | null {
    if (!text) {
      return null;
    }
    const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!match) {
      return null;
    }
    const month = parseInt(match[1], 10) - 1;
    const day = parseInt(match[2], 10);
    let year = parseInt(match[3], 10);
    if (year < 100) {
      year += 2000;
    }
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private extractDescription(html: string): string | null {
    const $ = cheerio.load(html);
    const main = $('main');
    let section: cheerio.Cheerio<any> | null = null;

    if (main.length) {
      const sections = main.find('section');
      if (sections.length > 1) {
        let best = sections.first();
        let bestScore = -1;
        sections.each((_i, el) => {
          const text = this.normalize($(el).text());
          const score = (text.match(/Date:/gi)?.length ?? 0) * 1000 + text.length;
          if (score > bestScore) {
            best = $(el);
            bestScore = score;
          }
        });
        section = best;
      } else if (sections.length === 1) {
        section = sections.first();
      }
    }

    if (!section || !section.length) {
      section = $('main').length ? main : $('body');
    }

    section.find('form, script, style, iframe').remove();
    section.find('*').each((_i, el) => {
      if ($(el).text().trim() === 'Apply now.') {
        $(el).remove();
      }
    });

    const raw = section.html() ?? '';
    return raw ? markdownConverter(raw) : null;
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

  private slugFromUrl(url: string): string {
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    return (
      path.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'role'
    );
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
      TROSSENROBOTICS_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
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
