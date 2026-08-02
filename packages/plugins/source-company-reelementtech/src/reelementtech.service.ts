import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
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
  REELEMENTTECH_CAREERS_URL,
  REELEMENTTECH_COMPANY_NAME,
  REELEMENTTECH_DEFAULT_RESULTS,
  REELEMENTTECH_DEFAULT_TIMEOUT_SECONDS,
  REELEMENTTECH_ORIGIN,
  REELEMENTTECH_ROLE_PATH,
} from './reelementtech.constants';
import {
  ReelementtechDetail,
  ReelementtechOpening,
} from './reelementtech.types';

@SourcePlugin({
  site: Site.REELEMENTTECH,
  name: 'ReElement Technologies',
  category: 'company',
})
@Injectable()
export class ReelementtechService implements IScraper {
  private readonly logger = new Logger(ReelementtechService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? REELEMENTTECH_DEFAULT_TIMEOUT_SECONDS,
      });

      const listingHtml = await this.fetchListingHtml(client);
      const openings = this.parseListing(listingHtml);
      if (openings.length === 0) {
        this.logger.warn(
          'ReElement Technologies: no roles found on the careers page',
        );
        return new JobResponseDto([]);
      }

      const settled = await Promise.allSettled(
        openings.map(async (opening) => {
          let detail: ReelementtechDetail = {
            title: null,
            description: null,
            location: null,
          };
          try {
            const html = await this.fetchDetailHtml(client, opening.jobUrl);
            detail = this.parseDetail(html);
          } catch (error: unknown) {
            this.logger.warn(
              `ReElement Technologies: detail fetch failed for ${opening.jobUrl} (${this.errorLabel(error)})`,
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
      this.logger.log(`ReElement Technologies: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(
        `ReElement Technologies scrape failed (${this.errorLabel(error)})`,
      );
      return new JobResponseDto([]);
    }
  }

  /**
   * Fetch the careers page HTML. Server-rendered Webflow — plain HTTP, no
   * headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(REELEMENTTECH_CAREERS_URL);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /**
   * Fetch a role's detail page HTML. Isolated so tests can substitute HTML.
   */
  protected async fetchDetailHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const res = await client.get<string>(url);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /**
   * Parse the careers board: each open role is an `<a class="job-heading">`
   * anchor to a `/jobs/{slug}` collection page, with a stated location in the
   * sibling paragraph of the same card. Deduped by slug.
   */
  private parseListing(html: string): ReelementtechOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: ReelementtechOpening[] = [];

    $(`a[href*="${REELEMENTTECH_ROLE_PATH}"]`).each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const slug = this.slugFromHref(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const card = $(el).closest('.brix---card---icon-left---content-right');
      const location =
        this.normalize(
          card.find('.brix---paragraph-default-12 p').first().text(),
        ) || null;

      openings.push({
        slug,
        jobUrl: this.absoluteUrl(href),
        title: this.normalize($(el).text()),
        location,
      });
    });

    return openings;
  }

  /** Parse a role detail page for title, description, and stated location. */
  private parseDetail(html: string): ReelementtechDetail {
    const $ = cheerio.load(html);

    const richtext = $('.w-richtext').first();
    const description = richtext.length
      ? markdownConverter(richtext.html() ?? null)
      : null;

    const pageTitle = this.normalize($('title').first().text()).replace(
      /^Job Application\s*[-\u2012-\u2015\u2212]\s*/i,
      '',
    );
    const title = pageTitle || null;

    return { title, description, location: null };
  }

  private toJobPost(
    opening: ReelementtechOpening,
    detail: ReelementtechDetail,
  ): JobPostDto {
    const title = opening.title || detail.title || opening.slug;

    const stated = opening.location ?? detail.location;
    const parsed = stated ? parseLocationList([stated]) : null;

    return new JobPostDto({
      id: `reelementtech-${opening.slug}`,
      site: Site.REELEMENTTECH,
      title,
      companyName: REELEMENTTECH_COMPANY_NAME,
      companyUrl: REELEMENTTECH_CAREERS_URL,
      jobUrl: opening.jobUrl,
      location: parsed?.location ?? null,
      description: detail.description,
      isRemote: parsed?.remoteMentioned ?? false,
      ...(parsed?.workFromHomeType
        ? { workFromHomeType: parsed.workFromHomeType }
        : {}),
      datePosted: null,
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
      REELEMENTTECH_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromHref(href: string): string {
    const path = href.split(/[?#]/)[0];
    const idx = path.indexOf(REELEMENTTECH_ROLE_PATH);
    const tail =
      idx >= 0 ? path.slice(idx + REELEMENTTECH_ROLE_PATH.length) : '';
    return tail.replace(/\/+$/, '').toLowerCase();
  }

  private absoluteUrl(href: string): string {
    try {
      return new URL(href, REELEMENTTECH_ORIGIN).toString();
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
