import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  CompensationDto,
  CompensationInterval,
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
  AVALANCHEFUSION_CAREERS_URL,
  AVALANCHEFUSION_COMPANY_NAME,
  AVALANCHEFUSION_DEFAULT_LOCATION,
  AVALANCHEFUSION_DEFAULT_RESULTS,
  AVALANCHEFUSION_DEFAULT_TIMEOUT_SECONDS,
  AVALANCHEFUSION_LISTING_URL,
  AVALANCHEFUSION_ORIGIN,
  AVALANCHEFUSION_PAY_INTERVALS,
  AVALANCHEFUSION_ROLE_PATH,
} from './avalanchefusion.constants';
import {
  AvalanchefusionDetail,
  AvalanchefusionOpening,
  AvalanchefusionPay,
} from './avalanchefusion.types';

@SourcePlugin({
  site: Site.AVALANCHEFUSION,
  name: 'Avalanche Energy',
  category: 'company',
})
@Injectable()
export class AvalanchefusionService implements IScraper {
  private readonly logger = new Logger(AvalanchefusionService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? AVALANCHEFUSION_DEFAULT_TIMEOUT_SECONDS,
      });

      const listingHtml = await this.fetchListingHtml(client);
      const openings = this.parseListing(listingHtml);
      if (openings.length === 0) {
        this.logger.warn('Avalanche Energy: no openings found on the board');
        return new JobResponseDto([]);
      }

      const settled = await Promise.allSettled(
        openings.map(async (opening) => {
          let detail: AvalanchefusionDetail = {
            title: null,
            description: null,
            salaryText: null,
            applyUrl: null,
          };
          try {
            const html = await this.fetchDetailHtml(client, opening.jobUrl);
            detail = this.parseDetail(html);
          } catch (error: unknown) {
            this.logger.warn(
              `Avalanche Energy: detail fetch failed for ${opening.jobUrl} (${this.errorLabel(error)})`,
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
      this.logger.log(`Avalanche Energy: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(
        `Avalanche Energy scrape failed (${this.errorLabel(error)})`,
      );
      return new JobResponseDto([]);
    }
  }

  /**
   * Fetch the open-positions board HTML. Server-rendered Webflow — plain HTTP,
   * no headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(AVALANCHEFUSION_LISTING_URL);
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
   * Parse the board: each open role is an anchor to a
   * `/careers/open-position/{slug}` collection page. Deduped by slug; the anchor
   * text is the role title.
   */
  private parseListing(html: string): AvalanchefusionOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: AvalanchefusionOpening[] = [];

    $(`a[href*="${AVALANCHEFUSION_ROLE_PATH}"]`).each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const slug = this.slugFromHref(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      openings.push({
        slug,
        jobUrl: this.absoluteUrl(href),
        title: this.normalize($(el).text()),
      });
    });

    return openings;
  }

  /** Parse a role detail page for title, description, salary, apply URL, site. */
  private parseDetail(html: string): AvalanchefusionDetail {
    const $ = cheerio.load(html);

    const title = this.normalize($('h2.blue.center-text').first().text()) || null;

    const richtext = $('.w-richtext').first();
    const description = richtext.length
      ? markdownConverter(richtext.html() ?? null)
      : null;

    const salaryText = this.normalize($('.salary-range').first().text()) || null;

    const applyUrl =
      $('a.button-primary[href], a[href]')
        .toArray()
        .map((el) => ({
          href: ($(el).attr('href') ?? '').trim(),
          text: this.normalize($(el).text()).toLowerCase(),
        }))
        .find((a) => a.href && a.text.startsWith('apply'))?.href ?? null;

    return { title, description, salaryText, applyUrl };
  }

  private toJobPost(
    opening: AvalanchefusionOpening,
    detail: AvalanchefusionDetail,
  ): JobPostDto {
    const title = opening.title || detail.title || opening.slug;

    const pay = this.payFromText(detail.salaryText);
    const compensation: CompensationDto | null = pay.text
      ? salaryToCompensation(
          pay.text,
          pay.interval ? { interval: pay.interval } : undefined,
        )
      : null;

    const parsed = parseLocationList([AVALANCHEFUSION_DEFAULT_LOCATION]);

    return new JobPostDto({
      id: `avalanchefusion-${opening.slug}`,
      site: Site.AVALANCHEFUSION,
      title,
      companyName: AVALANCHEFUSION_COMPANY_NAME,
      companyUrl: AVALANCHEFUSION_CAREERS_URL,
      jobUrl: opening.jobUrl,
      location: parsed.location,
      description: detail.description,
      isRemote: parsed.remoteMentioned,
      ...(parsed.workFromHomeType
        ? { workFromHomeType: parsed.workFromHomeType }
        : {}),
      ...(compensation ? { compensation } : {}),
      datePosted: null,
      emails: [],
      applyUrl: detail.applyUrl,
    });
  }

  /**
   * Extract the pay range and its authoritative interval. The interval comes
   * from the per-unit token (`/yr`, `/hr`, …) and is passed to the shared salary
   * parser so magnitude never guesses the period (Spec 5045 `interval` hint);
   * the token is stripped from the numeric input so the range regex can span it.
   */
  private payFromText(text: string | null): AvalanchefusionPay {
    if (!text) return { text: null, interval: undefined };
    const norm = text.replace(/\u00a0/g, ' ');
    const interval = this.detectInterval(norm);

    const match = norm.match(
      /\$\s?\d[\d.,]*\s*[KkMm]?\s*(?:\/\s*(?:hr|hrs|hour|day|wk|week|mo|month|yr|year))?\s*(?:-|\u2012|\u2013|\u2014|\u2015|\u2212|to)\s*\$?\s?\d[\d.,]*\s*[KkMm]?/i,
    );
    if (!match) return { text: null, interval };

    const cleaned = match[0]
      .replace(/\/\s*(?:hr|hrs|hour|day|wk|week|mo|month|yr|year)\b/gi, '')
      .replace(/[\u2012-\u2015\u2212]/g, '-')
      .replace(/,(?!\d)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { text: cleaned, interval };
  }

  private detectInterval(text: string): CompensationInterval | undefined {
    for (const [pattern, interval] of AVALANCHEFUSION_PAY_INTERVALS) {
      if (pattern.test(text)) return interval;
    }
    return undefined;
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
      AVALANCHEFUSION_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromHref(href: string): string {
    const path = href.split(/[?#]/)[0];
    const idx = path.indexOf(AVALANCHEFUSION_ROLE_PATH);
    const tail = idx >= 0 ? path.slice(idx + AVALANCHEFUSION_ROLE_PATH.length) : '';
    return tail.replace(/\/+$/, '').toLowerCase();
  }

  private absoluteUrl(href: string): string {
    try {
      return new URL(href, AVALANCHEFUSION_ORIGIN).toString();
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
