import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  markdownConverter,
  parseLocationList,
} from '@ever-jobs/common';
import {
  TERMINUS_CARD_CLASS,
  TERMINUS_CARD_TITLE_CLASS,
  TERMINUS_CAREERS_URL,
  TERMINUS_COMPANY_NAME,
  TERMINUS_DEFAULT_RESULTS,
  TERMINUS_DEFAULT_TIMEOUT_SECONDS,
  TERMINUS_DROPDOWN_INNER_CLASS,
  TERMINUS_META_ITEM_CLASS,
  TERMINUS_SECTION_CLASS,
} from './terminus.constants';
import { TerminusOpening } from './terminus.types';

@SourcePlugin({
  site: Site.TERMINUSINDUSTRIALS,
  name: 'Terminus Industrials',
  category: 'company',
})
@Injectable()
export class TerminusIndustrialsService implements IScraper {
  private readonly logger = new Logger(TerminusIndustrialsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? TERMINUS_DEFAULT_TIMEOUT_SECONDS,
      });

      const html = await this.fetchCareersHtml(client);
      const openings = this.parseCareers(html);
      if (openings.length === 0) {
        this.logger.warn('Terminus: no roles found on the careers page');
        return new JobResponseDto([]);
      }

      const jobs = openings.map((opening) => this.toJobPost(opening));
      const out = this.applyInput(jobs, input);
      this.logger.log(`Terminus: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`Terminus scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Fetch the careers page HTML. Server-rendered Next.js — plain HTTP, no
   * headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchCareersHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(TERMINUS_CAREERS_URL);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /**
   * Parse the careers page. Each role is a `Careers_card__*` block with the JD
   * rendered inline; there is no per-role detail page. Deduped by title.
   */
  private parseCareers(html: string): TerminusOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: TerminusOpening[] = [];

    $(this.sel(TERMINUS_CARD_CLASS)).each((_i, el) => {
      const card = $(el);
      const title = this.normalize(
        card.find(this.sel(TERMINUS_CARD_TITLE_CLASS)).first().text(),
      );
      if (!title) return;
      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      openings.push({
        title,
        ...this.metaFields($, card),
        description: this.descriptionFromSections($, card),
      });
    });

    return openings;
  }

  /**
   * Classify the meta-row chips: a `City, ST`-shaped chip is the location, a
   * job-type chip (Full-time, etc.) is the employment type, and the remaining
   * chip (matching a badge) is the department. Order is not assumed.
   */
  private metaFields(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<AnyNode>,
  ): Pick<TerminusOpening, 'department' | 'location' | 'employmentType'> {
    let department: string | null = null;
    let location: string | null = null;
    let employmentType: string | null = null;

    card.find(this.sel(TERMINUS_META_ITEM_CLASS)).each((_i, el) => {
      const text = this.normalize($(el).text());
      if (!text) return;
      if (!location && /[A-Za-z].*,\s*[A-Za-z]/.test(text)) {
        location = text;
      } else if (!employmentType && getJobTypeFromString(text)) {
        employmentType = text;
      } else if (!department) {
        department = text;
      }
    });

    return { department, location, employmentType };
  }

  /**
   * Assemble the JD from the inline named sections (Job Summary / Key
   * Responsibilities / Desired Qualifications), each `sectionTitle` + body
   * converted to markdown. Falls back to the whole dropdown body. Null if none.
   */
  private descriptionFromSections(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<AnyNode>,
  ): string | null {
    const parts: string[] = [];
    card.find(this.sel(TERMINUS_SECTION_CLASS)).each((_i, el) => {
      const md = markdownConverter($(el).html() ?? null);
      const trimmed = md ? md.trim() : '';
      if (trimmed) parts.push(trimmed);
    });
    if (parts.length) return parts.join('\n\n');

    const inner = card.find(this.sel(TERMINUS_DROPDOWN_INNER_CLASS)).first();
    const md = markdownConverter(inner.html() ?? null);
    const trimmed = md ? md.trim() : '';
    return trimmed || null;
  }

  private toJobPost(opening: TerminusOpening): JobPostDto {
    const slug = this.slugFromTitle(opening.title);
    const location = opening.location
      ? parseLocationList([opening.location]).location
      : null;
    const jobType = opening.employmentType
      ? getJobTypeFromString(opening.employmentType)
      : null;

    return new JobPostDto({
      id: `terminusindustrials-${slug}`,
      site: Site.TERMINUSINDUSTRIALS,
      title: opening.title,
      companyName: TERMINUS_COMPANY_NAME,
      companyUrl: TERMINUS_CAREERS_URL,
      // No per-role detail route; the careers page is the canonical URL.
      jobUrl: TERMINUS_CAREERS_URL,
      // Applying is an on-page modal form; no standalone apply URL exists.
      applyUrl: null,
      location,
      description: opening.description,
      isRemote: false,
      datePosted: null,
      ...(opening.department ? { department: opening.department } : {}),
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
        [job.title, job.description].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
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
      TERMINUS_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private sel(classPrefix: string): string {
    return `[class*="${classPrefix}"]`;
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
