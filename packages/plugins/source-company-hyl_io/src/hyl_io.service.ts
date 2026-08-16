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
  salaryToCompensation,
} from '@ever-jobs/common';
import {
  HYL_IO_BOARD_SLUG,
  HYL_IO_CAREERS_URL,
  HYL_IO_COMPANY_NAME,
  HYL_IO_DEFAULT_RESULTS,
  HYL_IO_DEFAULT_TIMEOUT_SECONDS,
  HYL_IO_ORIGIN,
  HYL_IO_ROLE_PATH,
} from './hyl_io.constants';
import { HylIoDetail, HylIoOpening } from './hyl_io.types';

@SourcePlugin({
  site: Site.HYL_IO,
  name: 'Hylio',
  category: 'company',
})
@Injectable()
export class HylIoService implements IScraper {
  private readonly logger = new Logger(HylIoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? HYL_IO_DEFAULT_TIMEOUT_SECONDS,
      });

      const listingHtml = await this.fetchListingHtml(client);
      const openings = this.parseListing(listingHtml);
      if (openings.length === 0) {
        this.logger.warn('Hylio: no roles found on the careers page');
        return new JobResponseDto([]);
      }

      const settled = await Promise.allSettled(
        openings.map(async (opening) => {
          let detail: HylIoDetail = {
            title: null,
            description: null,
            employmentType: null,
            payText: null,
          };
          // Only the company's own on-domain detail page is fetched; the Indeed
          // apply URL is never requested.
          if (opening.detailUrl) {
            try {
              const html = await this.fetchDetailHtml(
                client,
                opening.detailUrl,
              );
              detail = this.parseDetail(html);
            } catch (error: unknown) {
              this.logger.warn(
                `Hylio: detail fetch failed for ${opening.detailUrl} (${this.errorLabel(error)})`,
              );
            }
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
      this.logger.log(`Hylio: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`Hylio scrape failed (${this.errorLabel(error)})`);
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
    const res = await client.get<string>(HYL_IO_CAREERS_URL);
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
   * Parse the careers board: each open role is a `.jobtitle` block (the `<h1>`
   * title + the Indeed `APPLY` link) paired with a sibling `.jobinformation`
   * block that carries the on-domain `LEARN MORE` detail link. Deduped by slug.
   */
  private parseListing(html: string): HylIoOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: HylIoOpening[] = [];

    $('.jobtitle').each((_i, el) => {
      const card = $(el).closest('.w-layout-grid');
      const scope = card.length ? card : $(el);

      // The on-domain `/hiring/{slug}` detail link within the card (LEARN MORE),
      // excluding the board index itself.
      let detailHref: string | null = null;
      scope.find(`a[href*="${HYL_IO_ROLE_PATH}"]`).each((_j, a) => {
        if (detailHref) return;
        const href = $(a).attr('href') ?? '';
        const s = this.slugFromHref(href);
        if (s && s !== HYL_IO_BOARD_SLUG) detailHref = href;
      });
      if (!detailHref) return;
      const slug = this.slugFromHref(detailHref);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = this.headingText($, $(el).find('h1').first().html());
      const applyHref =
        scope.find('a[href*="indeed.com"]').first().attr('href') ?? null;

      openings.push({
        slug,
        detailUrl: this.absoluteUrl(detailHref),
        applyUrl: applyHref ? this.absoluteUrl(applyHref) : null,
        title,
      });
    });

    return openings;
  }

  /**
   * Parse a role detail page: the `<h1>` title, the description body (the
   * container holding the `About / Job Summary / Responsibilities /
   * Qualifications / Other` sections), and the `Job Type:` / `Pay:` lines.
   */
  private parseDetail(html: string): HylIoDetail {
    const $ = cheerio.load(html);

    const body = $('h1.subheading').first().parent();
    const description = body.length
      ? markdownConverter(body.html() ?? null)
      : null;
    const title =
      this.normalize(body.prevAll('h1').first().text()) ||
      this.normalize($('h1.heading').first().text()) ||
      null;

    const bodyText = body.length ? body.text() : $('body').text();
    const employmentType = this.employmentTypeFromText(bodyText);
    const payText = this.payFromText(bodyText);

    return { title, description, employmentType, payText };
  }

  private toJobPost(opening: HylIoOpening, detail: HylIoDetail): JobPostDto {
    const title = detail.title || opening.title || opening.slug;

    const normalizedType = this.normalizeEmploymentType(detail.employmentType);
    const jobType = detail.employmentType
      ? getJobTypeFromString(detail.employmentType)
      : null;

    const compensation = this.compensationFromPay(detail.payText);

    // Canonical URL is the employer's own on-domain detail page; the Indeed link
    // is the apply destination only. Fall back to the apply URL if a card has no
    // detail page.
    const jobUrl = opening.detailUrl ?? opening.applyUrl ?? HYL_IO_CAREERS_URL;

    return new JobPostDto({
      id: `hyl_io-${opening.slug}`,
      site: Site.HYL_IO,
      title,
      companyName: HYL_IO_COMPANY_NAME,
      companyUrl: HYL_IO_CAREERS_URL,
      jobUrl,
      // The site states no per-role location; never synthesize the HQ.
      location: null,
      description: detail.description,
      isRemote: false,
      ...(normalizedType ? { employmentType: normalizedType } : {}),
      ...(jobType ? { jobType: [jobType] } : {}),
      ...(compensation ? { compensation } : {}),
      datePosted: null,
      emails: [],
      ...(opening.applyUrl ? { applyUrl: opening.applyUrl } : {}),
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
      HYL_IO_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  /** Lift the employment type from a `Job Type: Full-time; ...` line. */
  private employmentTypeFromText(text: string): string | null {
    if (!text) return null;
    const norm = text.replace(/\u00a0/g, ' ');
    const m = norm.match(/job\s*type\s*:?\s*([^;.\n<]+)/i);
    return m ? this.normalize(m[1]) || null : null;
  }

  /** Lift the pay text (and its period) from a `Pay:` line. */
  private payFromText(text: string): string | null {
    if (!text) return null;
    const norm = text.replace(/\u00a0/g, ' ');
    const label = norm.match(/pay\s*:?/i);
    if (!label || label.index === undefined) return null;
    const region = norm.slice(label.index, label.index + 160);
    return /\$\s?\d/.test(region) ? region.replace(/\s+/g, ' ').trim() : null;
  }

  /**
   * Resolve stated pay into structured compensation via the shared salary
   * parser, which handles a two-ended range and a single stated bound. Returns
   * null when no amount is stated.
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

  private slugFromHref(href: string): string {
    const path = href.split(/[?#]/)[0];
    const idx = path.indexOf(HYL_IO_ROLE_PATH);
    const tail = idx >= 0 ? path.slice(idx + HYL_IO_ROLE_PATH.length) : '';
    return tail.replace(/\/+$/, '').toLowerCase();
  }

  private absoluteUrl(href: string): string {
    try {
      return new URL(href, HYL_IO_ORIGIN).toString();
    } catch {
      return href;
    }
  }

  /**
   * Text of a heading whose inner HTML may contain a `<br>` between words
   * (e.g. `DRONE<br/>TECHNICIAN`). Tags become spaces and entities are decoded.
   */
  private headingText(
    $: cheerio.CheerioAPI,
    html: string | null,
  ): string {
    if (!html) return '';
    return this.normalize($(`<div>${html.replace(/<br\s*\/?>/gi, ' ')}</div>`).text());
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
