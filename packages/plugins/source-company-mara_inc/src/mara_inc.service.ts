import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { SourcePlugin } from '@ever-jobs/plugin';
import { classifyScrapeError,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, parseLocationList } from '@ever-jobs/common';
import {
  MARA_INC_APPLY_SELECTOR,
  MARA_INC_CARD_SELECTOR,
  MARA_INC_CAREERS_URL,
  MARA_INC_COMPANY_NAME,
  MARA_INC_DEFAULT_RESULTS,
  MARA_INC_DEFAULT_TIMEOUT_SECONDS,
  MARA_INC_HIGHLIGHT_SELECTOR,
  MARA_INC_LABEL_SELECTOR,
  MARA_INC_TITLE_SELECTOR,
} from './mara_inc.constants';
import { MaraIncOpening } from './mara_inc.types';

@SourcePlugin({
  site: Site.MARA_INC,
  name: 'Mara Defense',
  category: 'company',
})
@Injectable()
export class MaraIncService implements IScraper {
  private readonly logger = new Logger(MaraIncService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? MARA_INC_DEFAULT_TIMEOUT_SECONDS,
      });

      const html = await this.fetchCareersHtml(client);
      const openings = this.parseCareers(html);
      if (openings.length === 0) {
        this.logger.warn('Mara: no openings found on the careers page');
        return new JobResponseDto([]);
      }

      const jobs = openings.map((opening) => this.toJobPost(opening));
      const out = this.applyInput(jobs, input);
      this.logger.log(`Mara: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`Mara scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([], classifyScrapeError(error));
    }
  }

  /**
   * Fetch the careers page HTML. Server-rendered Webflow — plain HTTP, no
   * headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchCareersHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(MARA_INC_CAREERS_URL);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /**
   * Parse the careers board. Each opening is a `.mr-job-content-box` card; the
   * template also renders a placeholder whose apply button points at `#`, so
   * only cards that carry a real LinkedIn apply URL are kept. Deduped by title.
   */
  private parseCareers(html: string): MaraIncOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: MaraIncOpening[] = [];

    $(MARA_INC_CARD_SELECTOR).each((_i, el) => {
      const card = $(el);

      const applyUrl = card.find(MARA_INC_APPLY_SELECTOR).first().attr('href');
      if (!applyUrl) return;

      const title = this.buildTitle($, card);
      if (!title) return;
      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      openings.push({
        title,
        applyUrl,
        ...this.labelFields($, card),
      });
    });

    return openings;
  }

  /**
   * Title = the large `.mr-h4` text. The small highlight chip
   * (`.label-transparant`) is appended in parentheses only when it is not
   * already contained in the large title.
   */
  private buildTitle(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<AnyNode>,
  ): string {
    const large = this.normalize(card.find(MARA_INC_TITLE_SELECTOR).first().text());
    if (!large) return '';

    const small = this.normalize(
      card.find(MARA_INC_HIGHLIGHT_SELECTOR).first().text(),
    );
    if (small && !large.toLowerCase().includes(small.toLowerCase())) {
      return `${large} (${small})`;
    }
    return large;
  }

  /**
   * Classify the two `.label-location` chips by shape: a chip recognised as a
   * job type (Full Time, etc.) is the employment type, the other is the
   * location. Order is not assumed.
   */
  private labelFields(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<AnyNode>,
  ): Pick<MaraIncOpening, 'location' | 'employmentType'> {
    let location: string | null = null;
    let employmentType: string | null = null;

    card.find(MARA_INC_LABEL_SELECTOR).each((_i, el) => {
      const text = this.normalize($(el).text());
      if (!text) return;
      if (!employmentType && getJobTypeFromString(text)) {
        employmentType = text;
      } else if (!location) {
        location = text;
      }
    });

    return { location, employmentType };
  }

  private toJobPost(opening: MaraIncOpening): JobPostDto {
    const slug = this.slugFromTitle(opening.title);
    const location = opening.location
      ? parseLocationList([opening.location]).location
      : null;
    const jobType = opening.employmentType
      ? getJobTypeFromString(opening.employmentType)
      : null;

    return new JobPostDto({
      id: `mara_inc-${slug}`,
      site: Site.MARA_INC,
      title: opening.title,
      companyName: MARA_INC_COMPANY_NAME,
      companyUrl: MARA_INC_CAREERS_URL,
      // No on-domain per-role page; jobUrl is intentionally left blank.
      jobUrl: '',
      // Applying is handled off-domain on LinkedIn (linked, never fetched).
      applyUrl: opening.applyUrl,
      location,
      isRemote: false,
      datePosted: null,
      ...(opening.employmentType ? { employmentType: opening.employmentType } : {}),
      ...(jobType ? { jobType: [jobType] } : {}),
      emails: [],
    });
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        this.normalize(job.title).toLowerCase().includes(searchTerm),
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
      MARA_INC_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
    if (!error || typeof error !== 'object') return 'unknown error';
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === 'number') return `HTTP ${status}`;
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
