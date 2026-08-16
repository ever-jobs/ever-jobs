import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import { classifyScrapeError,
  CompensationDto,
  CompensationInterval,
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
  salaryToCompensation,
} from '@ever-jobs/common';
import {
  FLYMOTIONUS_CAREERS_URL,
  FLYMOTIONUS_COMPANY_NAME,
  FLYMOTIONUS_DEFAULT_RESULTS,
  FLYMOTIONUS_DEFAULT_TIMEOUT_SECONDS,
  FLYMOTIONUS_ORIGIN,
  FLYMOTIONUS_ROLE_PATH,
} from './flymotionus.constants';
import { FlymotionusDetail, FlymotionusOpening } from './flymotionus.types';

@SourcePlugin({
  site: Site.FLYMOTIONUS,
  name: 'FLYMOTION',
  category: 'company',
})
@Injectable()
export class FlymotionusService implements IScraper {
  private readonly logger = new Logger(FlymotionusService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? FLYMOTIONUS_DEFAULT_TIMEOUT_SECONDS,
      });

      const listingHtml = await this.fetchListingHtml(client);
      const openings = this.parseListing(listingHtml);
      if (openings.length === 0) {
        this.logger.warn('FLYMOTION: no roles found on the careers page');
        return new JobResponseDto([]);
      }

      const settled = await Promise.allSettled(
        openings.map(async (opening) => {
          let detail: FlymotionusDetail = {
            title: null,
            description: null,
            location: null,
            employmentType: null,
            datePosted: null,
            payText: null,
          };
          try {
            const html = await this.fetchDetailHtml(client, opening.jobUrl);
            detail = this.parseDetail(html);
          } catch (error: unknown) {
            this.logger.warn(
              `FLYMOTION: detail fetch failed for ${opening.jobUrl} (${this.errorLabel(error)})`,
            );
          }
          return this.toJobPost(opening, detail);
        }),
      );

      const jobs = settled
        .filter(
          (s): s is PromiseFulfilledResult<JobPostDto> =>
            s.status === 'fulfilled',
        )
        .map((s) => s.value);

      const out = this.applyInput(jobs, input);
      this.logger.log(`FLYMOTION: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`FLYMOTION scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([], classifyScrapeError(error));
    }
  }

  /**
   * Fetch the careers page HTML. Server-rendered Webflow — plain HTTP, no
   * headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(FLYMOTIONUS_CAREERS_URL);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /** Fetch a role's detail page HTML. Isolated so tests can substitute HTML. */
  protected async fetchDetailHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const res = await client.get<string>(url);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /**
   * Parse the careers board: each open role is a `.careers-job-listing-panel`
   * card with an `<a href="/jobs/{slug}">` action, an `<h3>` title, a location
   * badge, and an employment-type detail. Deduped by slug.
   */
  private parseListing(html: string): FlymotionusOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: FlymotionusOpening[] = [];

    $(`a[href*="${FLYMOTIONUS_ROLE_PATH}"]`).each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const slug = this.slugFromHref(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const card = $(el).closest('.careers-job-listing-panel');
      const title =
        this.normalize(card.find('.careers-job-listing-panel-heading').text()) ||
        this.normalize($(el).text());
      const location =
        this.normalize(card.find('.careers-job-listing-category-badge').text()) ||
        null;
      const employmentType =
        this.normalize(
          card.find('.careers-job-listing-detail-panel').last().text(),
        ) || null;

      openings.push({
        slug,
        jobUrl: this.absoluteUrl(href),
        title,
        location,
        employmentType,
      });
    });

    return openings;
  }

  /**
   * Parse a role detail page: `<h1>` title, the `.w-richtext` description, the
   * labelled detail cards (Job Type / Location / Posted), and a pay line lifted
   * from the rich-text `Pay:` section.
   */
  private parseDetail(html: string): FlymotionusDetail {
    const $ = cheerio.load(html);

    const title = this.normalize($('h1').first().text()) || null;

    const richtext = $('.w-richtext').first();
    const description = richtext.length
      ? markdownConverter(richtext.html() ?? null)
      : null;

    const cards = this.detailCards($);
    const location = cards.get('location') ?? null;
    const employmentType = cards.get('job type') ?? null;
    const datePosted = this.parseDate(cards.get('posted'));

    const payText = this.payFromRichtext(richtext.text());

    return { title, description, location, employmentType, datePosted, payText };
  }

  /** Map each detail card's lowercased heading label to its stated value. */
  private detailCards($: cheerio.CheerioAPI): Map<string, string> {
    const map = new Map<string, string>();
    $('.job-detail-heading-wrapper').each((_i, el) => {
      const label = this.normalize($(el).find('.job-details-heading').text())
        .toLowerCase();
      const value = this.normalize($(el).find('.job-detail-card').text());
      if (label && value && !map.has(label)) map.set(label, value);
    });
    return map;
  }

  private toJobPost(
    opening: FlymotionusOpening,
    detail: FlymotionusDetail,
  ): JobPostDto {
    const title = detail.title || opening.title || opening.slug;

    const stated = detail.location ?? opening.location;
    const parsed = stated ? parseLocationList([stated]) : null;

    const employmentType = detail.employmentType ?? opening.employmentType;
    const normalizedType = this.normalizeEmploymentType(employmentType);
    const jobType = employmentType ? getJobTypeFromString(employmentType) : null;

    const compensation = this.compensationFromPay(detail.payText);

    return new JobPostDto({
      id: `flymotionus-${opening.slug}`,
      site: Site.FLYMOTIONUS,
      title,
      companyName: FLYMOTIONUS_COMPANY_NAME,
      companyUrl: FLYMOTIONUS_CAREERS_URL,
      jobUrl: opening.jobUrl,
      location: parsed?.location ?? null,
      description: detail.description,
      isRemote: parsed?.remoteMentioned ?? false,
      ...(parsed?.workFromHomeType
        ? { workFromHomeType: parsed.workFromHomeType }
        : {}),
      ...(normalizedType ? { employmentType: normalizedType } : {}),
      ...(jobType ? { jobType: [jobType] } : {}),
      ...(compensation ? { compensation } : {}),
      datePosted: detail.datePosted,
      emails: [],
      applyUrl: opening.jobUrl,
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
      FLYMOTIONUS_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  /** Lift the pay text (and its period) from the rich-text `Pay:` section. */
  private payFromRichtext(text: string): string | null {
    if (!text) return null;
    const norm = text.replace(/\u00a0/g, ' ');
    const label = norm.match(/pay\s*:?/i);
    if (!label || label.index === undefined) return null;
    const region = norm.slice(label.index, label.index + 160);
    return /\$\s?\d/.test(region) ? region.replace(/\s+/g, ' ').trim() : null;
  }

  /**
   * Resolve stated pay into structured compensation via the shared salary
   * parser, which handles both a two-ended range and a single stated bound
   * ("From $48,000 per year" → min-only) as of Spec 5058. Returns null when no
   * amount is stated.
   */
  private compensationFromPay(payText: string | null): CompensationDto | null {
    if (!payText) return null;
    const interval = /per\s+hour|hourly|\/\s*hr\b/i.test(payText)
      ? CompensationInterval.HOURLY
      : CompensationInterval.YEARLY;
    return salaryToCompensation(payText, { interval });
  }

  private normalizeEmploymentType(value: string | null): string | null {
    if (!value) return null;
    const v = value.toLowerCase();
    if (/full[-\s]?time/.test(v)) return 'Full-time';
    if (/part[-\s]?time/.test(v)) return 'Part-time';
    if (/contract/.test(v)) return 'Contract';
    if (/intern/.test(v)) return 'Internship';
    if (/temporary/.test(v)) return 'Temporary';
    return this.normalize(value) || null;
  }

  private parseDate(value: string | undefined): Date | null {
    if (!value) return null;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : new Date(ts);
  }

  private slugFromHref(href: string): string {
    const path = href.split(/[?#]/)[0];
    const idx = path.indexOf(FLYMOTIONUS_ROLE_PATH);
    const tail = idx >= 0 ? path.slice(idx + FLYMOTIONUS_ROLE_PATH.length) : '';
    return tail.replace(/\/+$/, '').toLowerCase();
  }

  private absoluteUrl(href: string): string {
    try {
      return new URL(href, FLYMOTIONUS_ORIGIN).toString();
    } catch {
      return href;
    }
  }

  private normalize(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
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
