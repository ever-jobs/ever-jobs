import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
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
import { BrowserPool, markdownConverter } from '@ever-jobs/common';
import type { Page } from 'playwright';
import {
  CHANGROBOTICS_AI_CAREERS_URL,
  CHANGROBOTICS_AI_COMPANY_NAME,
  CHANGROBOTICS_AI_DEFAULT_RESULTS,
  CHANGROBOTICS_AI_DEFAULT_TIMEOUT_SECONDS,
  CHANGROBOTICS_AI_LIST_SELECTOR,
  CHANGROBOTICS_AI_ORIGIN,
  CHANGROBOTICS_AI_READY_TIMEOUT_SECONDS,
} from './changrobotics_ai.constants';
import { ChangroboticsAiJobCard } from './changrobotics_ai.types';

@SourcePlugin({
  site: Site.CHANGROBOTICS_AI,
  name: 'Chang Robotics',
  category: 'company',
  companyDomains: ['changrobotics.ai'],
})
@Injectable()
export class ChangroboticsAiService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(ChangroboticsAiService.name);

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      this.logger.log(`Chang Robotics: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Chang Robotics scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const proxy = input.proxies?.[0];
    const timeoutMs =
      (input.requestTimeout ?? CHANGROBOTICS_AI_DEFAULT_TIMEOUT_SECONDS) * 1000;

    const page = await BrowserPool.getPage({
      proxy,
      stealth: true,
      headful: true,
    });

    try {
      const startUrl = input.companyUrl || CHANGROBOTICS_AI_CAREERS_URL;
      const listHtml = await this.fetchHtml(
        startUrl,
        page,
        timeoutMs,
        CHANGROBOTICS_AI_LIST_SELECTOR,
      );
      const cards = this.parseListPage(listHtml, startUrl);
      return cards.map((card) => this.toJobPost(card, startUrl));
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  protected async fetchHtml(
    url: string,
    page?: Page,
    timeoutMs?: number,
    waitSelector?: string,
  ): Promise<string> {
    const timeout = timeoutMs ?? CHANGROBOTICS_AI_DEFAULT_TIMEOUT_SECONDS * 1000;

    const p = page ?? (await BrowserPool.getPage({ stealth: true, headful: true }));
    try {
      await BrowserPool.navigate(p, url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      const ready = waitSelector ?? CHANGROBOTICS_AI_LIST_SELECTOR;
      await p
        .waitForSelector(ready, {
          timeout: CHANGROBOTICS_AI_READY_TIMEOUT_SECONDS * 1000,
        })
        .catch(() => undefined);
      return p.content();
    } finally {
      if (!page) {
        await p.close().catch(() => undefined);
      }
    }
  }

  private parseListPage(html: string, companyUrl: string): ChangroboticsAiJobCard[] {
    const $ = cheerio.load(html);
    const cards: ChangroboticsAiJobCard[] = [];
    const seen = new Set<string>();

    $(CHANGROBOTICS_AI_LIST_SELECTOR).each((_i, el) => {
      const item = $(el);
      const title = this.normalize(
        item.find('.wixui-accordion__title').first().text(),
      );
      if (!title) {
        return;
      }

      const content = item
        .find('div[role="region"], div[class*="animationBox"]')
        .first();
      const richText = content.find('div[data-testid="richTextElement"]').first();
      const descriptionHtml = richText.html() ?? content.html() ?? '';

      const applyLink = content
        .find('a[aria-label="Apply Now"]')
        .first();
      let applyUrl = applyLink.attr('href')?.trim() ?? null;
      if (!applyUrl) {
        const fallback = item.find('a[aria-label="Apply Now"]').first().attr('href');
        applyUrl = fallback?.trim() ?? null;
      }
      applyUrl = this.resolveUrl(applyUrl, CHANGROBOTICS_AI_ORIGIN);

      const contentText = this.normalize(content.text() || item.text());

      const key = `${title}|${applyUrl ?? ''}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      cards.push({
        title,
        descriptionHtml,
        applyUrl,
        locationText: contentText,
      });
    });

    return cards;
  }

  private toJobPost(card: ChangroboticsAiJobCard, companyUrl: string): JobPostDto {
    const description = card.descriptionHtml
      ? markdownConverter(card.descriptionHtml)
      : null;
    const location = this.parseLocation(card.locationText);
    const { isRemote, workFromHomeType } = this.parseWorkplace(card.locationText);
    const jobTypes = this.buildJobTypes(card.locationText, card.title);
    const employmentType = this.buildEmploymentType(jobTypes);

    const id = `changrobotics_ai-${this.slugify(card.title)}`;

    return new JobPostDto({
      id,
      site: Site.CHANGROBOTICS_AI,
      title: card.title,
      companyName: CHANGROBOTICS_AI_COMPANY_NAME,
      companyUrl,
      jobUrl: companyUrl,
      applyUrl: card.applyUrl,
      location,
      description,
      isRemote,
      workFromHomeType: workFromHomeType ?? undefined,
      jobType: jobTypes,
      employmentType,
    });
  }

  private parseLocation(text: string | null): LocationDto | null {
    if (!text) {
      return null;
    }

    const match = text.match(
      /[Mm]ust live in\s+([A-Za-z\s]+?),\s*([A-Z]{2})(?:,\s*([A-Za-z\s]+?))?/,
    );
    if (match) {
      return new LocationDto({
        city: this.normalize(match[1]),
        state: this.normalize(match[2]),
        country: Country.USA,
      });
    }

    const generic = text.match(
      /\b(?:located?|location)[:\s]+([A-Za-z\s]+?),\s*([A-Z]{2})\b/,
    );
    if (generic) {
      return new LocationDto({
        city: this.normalize(generic[1]),
        state: this.normalize(generic[2]),
        country: Country.USA,
      });
    }

    return null;
  }

  private parseWorkplace(text: string | null): {
    isRemote: boolean;
    workFromHomeType: string | null;
  } {
    if (!text) {
      return { isRemote: false, workFromHomeType: null };
    }
    const lower = text.toLowerCase();
    if (lower.includes('hybrid')) {
      return { isRemote: false, workFromHomeType: 'Hybrid' };
    }
    if (/\bremote\b/.test(lower)) {
      return { isRemote: true, workFromHomeType: 'Remote' };
    }
    if (/\bon[- ]?site\b/.test(lower) || lower.includes('in office')) {
      return { isRemote: false, workFromHomeType: 'On Site' };
    }
    return { isRemote: false, workFromHomeType: null };
  }

  private buildJobTypes(text: string | null, title: string): JobType[] {
    const out: JobType[] = [];
    const source = `${text ?? ''} ${title}`;
    const tokens = this.extractJobTypeTokens(source);
    for (const token of tokens) {
      const normalized = token.toLowerCase().replace(/[\s-/]/g, '');
      const jobType =
        getJobTypeFromString(normalized === 'intern' ? 'internship' : normalized);
      if (jobType && !out.includes(jobType)) {
        out.push(jobType);
      }
    }
    if (!out.length) {
      out.push(JobType.FULL_TIME);
    }
    return out;
  }

  private extractJobTypeTokens(text: string): string[] {
    const matches = text.match(
      /\b(?:full[- ]?time|part[- ]?time|contract(?:or)?|temporary|intern(?:ship)?|freelance|per[- ]?diem)\b/gi,
    );
    return matches ?? [];
  }

  private buildEmploymentType(jobTypes: JobType[]): string {
    if (jobTypes.length === 1) {
      switch (jobTypes[0]) {
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
        default:
          return 'Full time';
      }
    }
    return jobTypes.map((t) => this.jobTypeLabel(t)).join(' | ');
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
      default:
        return String(jobType);
    }
  }

  private resolveUrl(href: string | null, origin: string): string | null {
    if (!href) {
      return null;
    }
    href = href.trim();
    if (!href) {
      return null;
    }
    if (/^https?:\/\//i.test(href)) {
      return href;
    }
    if (href.startsWith('/')) {
      return `${origin}${href}`;
    }
    return `${origin}/${href}`;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
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
      CHANGROBOTICS_AI_DEFAULT_RESULTS,
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
    const status = (error as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number') {
      return `HTTP ${status}`;
    }
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
