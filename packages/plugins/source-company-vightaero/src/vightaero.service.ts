import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
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
import {
  createHttpClient,
  markdownConverter,
  parseLocationList,
} from '@ever-jobs/common';
import {
  VIGHTAERO_CAREERS_URL,
  VIGHTAERO_CF_EMAIL_PATH,
  VIGHTAERO_COMPANY_NAME,
  VIGHTAERO_DEFAULT_RESULTS,
  VIGHTAERO_DEFAULT_TIMEOUT_SECONDS,
  VIGHTAERO_ORIGIN,
} from './vightaero.constants';
import { VightaeroDetail, VightaeroOpening } from './vightaero.types';

@SourcePlugin({
  site: Site.VIGHTAERO,
  name: 'Vight',
  category: 'company',
})
@Injectable()
export class VightaeroService implements IScraper {
  private readonly logger = new Logger(VightaeroService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? VIGHTAERO_DEFAULT_TIMEOUT_SECONDS,
      });

      const listingHtml = await this.fetchListingHtml(client);
      const openings = this.parseListing(listingHtml);
      if (openings.length === 0) {
        this.logger.warn('Vight: no roles found on the careers page');
        return new JobResponseDto([]);
      }

      const settled = await Promise.allSettled(
        openings.map(async (opening) => {
          let detail: VightaeroDetail | null = null;
          if (opening.detailUrl) {
            try {
              const html = await this.fetchDetailHtml(client, opening.detailUrl);
              detail = this.parseDetail(html);
            } catch (error: unknown) {
              this.logger.warn(
                `Vight: detail fetch failed for ${opening.detailUrl} (${this.errorLabel(error)})`,
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
      this.logger.log(`Vight: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`Vight scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([], classifyScrapeError(error));
    }
  }

  /**
   * Fetch the careers page HTML. Server-rendered static site — plain HTTP, no
   * headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(VIGHTAERO_CAREERS_URL);
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
   * Parse the listing: each `<article class="role">` card carries a stable `id`
   * (the slug), a title, a one-line copy, meta chips, and an apply link. A card
   * whose apply link is an on-domain path links to a `/join-us/{slug}/` detail
   * page; a card whose apply link is a Cloudflare email-protected anchor (the
   * generalist) is emitted from the card alone.
   */
  private parseListing(html: string): VightaeroOpening[] {
    const $ = cheerio.load(html);
    const openings: VightaeroOpening[] = [];

    $('article.role').each((_i, el) => {
      const card = $(el);
      const slug = this.normalize(card.attr('id'));
      const title = this.normalize(card.find('.role-title').first().text());
      if (!slug || !title) return;

      const copy = this.normalize(card.find('.role-copy').first().text()) || null;
      const chips = card
        .find('.role-meta span')
        .map((_j, s) => this.normalize($(s).text()))
        .get()
        .filter(Boolean);
      const { locationText, employmentText } = this.classifyMeta(chips);

      const applyHref = card.find('a.apply').first().attr('href') ?? '';
      const isEmailApply =
        applyHref.toLowerCase().startsWith('mailto:') ||
        applyHref.includes(VIGHTAERO_CF_EMAIL_PATH);
      const detailUrl =
        !isEmailApply && applyHref ? this.absoluteUrl(applyHref) : null;
      const email = isEmailApply ? this.emailFromHref(applyHref) : null;

      openings.push({
        slug,
        title,
        copy,
        locationText,
        employmentText,
        detailUrl,
        email,
      });
    });

    return openings;
  }

  /**
   * Parse a role detail page: the `<h1>` title, the `Location · Type · On site`
   * meta line, the JD body assembled from every `<section>`, and the apply email
   * decoded from the Cloudflare-protected apply link.
   */
  private parseDetail(html: string): VightaeroDetail {
    const $ = cheerio.load(html);

    const title = this.normalize($('h1').first().text()) || null;
    const chips = this.normalize($('.meta').first().text())
      .split('\u00b7')
      .map((c) => this.normalize(c))
      .filter(Boolean);
    const { locationText, employmentText } = this.classifyMeta(chips);
    const description = this.descriptionFromSections($);
    const email = this.emailFromHref(
      $('a.apply').first().attr('href') ?? '',
    );

    return { title, locationText, employmentText, description, email };
  }

  private toJobPost(
    opening: VightaeroOpening,
    detail: VightaeroDetail | null,
  ): JobPostDto {
    const title = detail?.title || opening.title;
    const locationText = detail?.locationText ?? opening.locationText;
    const employmentText = detail?.employmentText ?? opening.employmentText;
    const location = locationText
      ? parseLocationList([locationText]).location
      : null;
    const jobType = employmentText ? getJobTypeFromString(employmentText) : null;
    const description = detail?.description ?? opening.copy ?? null;
    const email = detail?.email ?? opening.email;

    return new JobPostDto({
      id: `vightaero-${opening.slug}`,
      site: Site.VIGHTAERO,
      title,
      companyName: VIGHTAERO_COMPANY_NAME,
      companyUrl: VIGHTAERO_CAREERS_URL,
      // Canonical URL is the employer's own detail page; the generalist has none.
      jobUrl: opening.detailUrl ?? VIGHTAERO_CAREERS_URL,
      location,
      description,
      isRemote: false,
      ...(employmentText ? { employmentType: employmentText } : {}),
      ...(jobType ? { jobType: [jobType] } : {}),
      datePosted: null,
      // Apply is by email (join@vightaero.com); a mailto: is not a web URL, so
      // the address lives in `emails` and `applyUrl` is left unset.
      emails: email ? [email] : [],
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
      VIGHTAERO_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  /**
   * Classify meta chips: a `City, ST` chip is the location; the first chip that
   * resolves to a known job type is the employment type. Other chips (e.g.
   * `On site`, `Exceptional fit`) are ignored, so the generalist yields neither.
   */
  private classifyMeta(chips: string[]): {
    locationText: string | null;
    employmentText: string | null;
  } {
    let locationText: string | null = null;
    let employmentText: string | null = null;
    for (const chip of chips) {
      if (!locationText && /,\s*[A-Za-z]{2}$/.test(chip)) {
        locationText = chip;
      } else if (!employmentText && getJobTypeFromString(chip)) {
        employmentText = chip;
      }
    }
    return { locationText, employmentText };
  }

  /**
   * Assemble the description from every `<section>` in document order,
   * converting each to markdown (headings + lists). Returns null if none exist.
   */
  private descriptionFromSections($: cheerio.CheerioAPI): string | null {
    const parts: string[] = [];
    $('section').each((_i, el) => {
      const md = markdownConverter($(el).html() ?? null);
      const trimmed = md ? md.trim() : '';
      if (trimmed) parts.push(trimmed);
    });
    return parts.length ? parts.join('\n\n') : null;
  }

  /**
   * Resolve an apply email from an anchor href: a `mailto:` address, or a
   * Cloudflare email-protected (`/cdn-cgi/l/email-protection#<hex>`) token. The
   * trailing `?subject=` is dropped. Returns null when no address is present.
   */
  private emailFromHref(href: string): string | null {
    if (!href) return null;
    if (href.toLowerCase().startsWith('mailto:')) {
      const addr = href.slice('mailto:'.length).split('?')[0].trim();
      return addr.includes('@') ? addr : null;
    }
    return this.decodeCfEmail(href);
  }

  /**
   * Decode a Cloudflare email-protection token: the first byte is the XOR key,
   * each subsequent byte is XORed with it. The decoded string is the address
   * plus an optional `?subject=` which is stripped.
   */
  private decodeCfEmail(href: string): string | null {
    const hashIdx = href.indexOf('#');
    if (!href.includes(VIGHTAERO_CF_EMAIL_PATH) || hashIdx < 0) return null;
    const hex = href.slice(hashIdx + 1);
    if (hex.length < 4 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      return null;
    }
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    const addr = out.split('?')[0].trim();
    return addr.includes('@') ? addr : null;
  }

  private absoluteUrl(href: string): string {
    try {
      return new URL(href, VIGHTAERO_CAREERS_URL).toString();
    } catch {
      try {
        return new URL(href, VIGHTAERO_ORIGIN).toString();
      } catch {
        return href;
      }
    }
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
