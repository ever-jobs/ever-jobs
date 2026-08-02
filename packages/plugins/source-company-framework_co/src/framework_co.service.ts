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
  FRAMEWORK_CO_APPLY_URL,
  FRAMEWORK_CO_CAREERS_URL,
  FRAMEWORK_CO_COMPANY_NAME,
  FRAMEWORK_CO_DEFAULT_RESULTS,
  FRAMEWORK_CO_DEFAULT_TIMEOUT_SECONDS,
  FRAMEWORK_CO_JD_SECTION_NAMES,
  FRAMEWORK_CO_LOCATION_FRAMER_NAME,
  FRAMEWORK_CO_ORIGIN,
  FRAMEWORK_CO_ROLE_PATH,
  FRAMEWORK_CO_SALARY_FRAMER_NAME,
} from './framework_co.constants';
import { FrameworkCoDetail, FrameworkCoOpening } from './framework_co.types';

@SourcePlugin({
  site: Site.FRAMEWORK_CO,
  name: 'Framework Automation',
  category: 'company',
})
@Injectable()
export class FrameworkCoService implements IScraper {
  private readonly logger = new Logger(FrameworkCoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? FRAMEWORK_CO_DEFAULT_TIMEOUT_SECONDS,
      });

      const listingHtml = await this.fetchListingHtml(client);
      const openings = this.parseListing(listingHtml);
      if (openings.length === 0) {
        this.logger.warn('Framework: no roles found on the careers page');
        return new JobResponseDto([]);
      }

      const settled = await Promise.allSettled(
        openings.map(async (opening) => {
          let detail: FrameworkCoDetail = {
            title: null,
            location: null,
            salaryText: null,
            description: null,
          };
          try {
            const html = await this.fetchDetailHtml(client, opening.detailUrl);
            detail = this.parseDetail(html);
          } catch (error: unknown) {
            this.logger.warn(
              `Framework: detail fetch failed for ${opening.detailUrl} (${this.errorLabel(error)})`,
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
      this.logger.log(`Framework: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`Framework scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Fetch the careers page HTML. Server-rendered Framer — plain HTTP, no
   * headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(FRAMEWORK_CO_CAREERS_URL);
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
   * Parse the careers board: each open role links to an on-domain
   * `/jobs/{slug}` detail page. Deduped by slug. The Framer listing markup is
   * soup (title/location are not reliably inside the anchor), so enumeration
   * only harvests the slug — the title/location come from the detail page (with
   * a slug-derived title as the fallback when a detail page cannot be fetched).
   */
  private parseListing(html: string): FrameworkCoOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: FrameworkCoOpening[] = [];

    $(`a[href*="${FRAMEWORK_CO_ROLE_PATH}"]`).each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const slug = this.slugFromHref(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      openings.push({
        slug,
        detailUrl: this.absoluteUrl(`${FRAMEWORK_CO_ROLE_PATH}${slug}`),
        title: this.titleFromSlug(slug),
      });
    });

    return openings;
  }

  /**
   * Parse a role detail page: the `<title>` role name, the `Location` and
   * `Salary` Framer named containers, and the JD body assembled from the named
   * rich-text sections (see FRAMEWORK_CO_JD_SECTION_NAMES).
   */
  private parseDetail(html: string): FrameworkCoDetail {
    const $ = cheerio.load(html);

    const title = this.titleFromDocTitle($);
    const location = this.framerNamedText($, FRAMEWORK_CO_LOCATION_FRAMER_NAME);
    const salaryText = this.framerNamedText($, FRAMEWORK_CO_SALARY_FRAMER_NAME);
    const description = this.descriptionFromSections($);

    return { title, location, salaryText, description };
  }

  private toJobPost(
    opening: FrameworkCoOpening,
    detail: FrameworkCoDetail,
  ): JobPostDto {
    const title = detail.title || opening.title;
    const location = detail.location
      ? parseLocationList([detail.location]).location
      : null;
    const compensation = this.compensationFromSalary(detail.salaryText);

    return new JobPostDto({
      id: `framework_co-${opening.slug}`,
      site: Site.FRAMEWORK_CO,
      title,
      companyName: FRAMEWORK_CO_COMPANY_NAME,
      companyUrl: FRAMEWORK_CO_CAREERS_URL,
      // Canonical URL is the employer's own on-domain detail page.
      jobUrl: opening.detailUrl,
      // Applying is a single shared on-domain form; no per-role apply URL exists.
      applyUrl: FRAMEWORK_CO_APPLY_URL,
      location,
      description: detail.description,
      isRemote: false,
      ...(compensation ? { compensation } : {}),
      datePosted: null,
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
      FRAMEWORK_CO_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  /**
   * Resolve the stated salary into structured compensation via the shared
   * parser. Framework states a two-ended yearly range (e.g.
   * `$150k-$200k+ | Generous Equity`); the parser reads the range and ignores
   * the trailing `+` / equity note. Returns null when no amount is stated.
   */
  private compensationFromSalary(
    salaryText: string | null,
  ): CompensationDto | null {
    if (!salaryText || !/\$\s?\d/.test(salaryText)) return null;
    return salaryToCompensation(salaryText, {
      interval: CompensationInterval.YEARLY,
    });
  }

  /** Role title from `<title>Senior Software Engineer - Framework</title>`. */
  private titleFromDocTitle($: cheerio.CheerioAPI): string | null {
    const raw = this.normalize($('title').first().text());
    if (!raw) return null;
    const cut = raw.replace(/\s*[-–|]\s*Frameworks?\b.*$/i, '');
    return this.normalize(cut) || raw;
  }

  /** Text of the first Framer rich-text container with the given name. */
  private framerNamedText(
    $: cheerio.CheerioAPI,
    name: string,
  ): string | null {
    const el = $(`[data-framer-name="${name}"]`).first();
    if (!el.length) return null;
    const text = this.normalize(el.text());
    return text || null;
  }

  /**
   * Assemble the description from the named JD sections in document order,
   * converting each section's HTML to markdown. Returns null if none are found.
   */
  private descriptionFromSections($: cheerio.CheerioAPI): string | null {
    const wanted = new Set(FRAMEWORK_CO_JD_SECTION_NAMES);
    const parts: string[] = [];
    $('[data-framer-name]').each((_i, el) => {
      const name = $(el).attr('data-framer-name') ?? '';
      if (!wanted.has(name)) return;
      const md = markdownConverter($(el).html() ?? null);
      const trimmed = md ? md.trim() : '';
      if (trimmed) parts.push(trimmed);
    });
    return parts.length ? parts.join('\n\n') : null;
  }

  private slugFromHref(href: string): string {
    const path = href.split(/[?#]/)[0];
    const idx = path.indexOf(FRAMEWORK_CO_ROLE_PATH);
    const tail = idx >= 0 ? path.slice(idx + FRAMEWORK_CO_ROLE_PATH.length) : '';
    return tail.replace(/^\/+|\/+$/g, '').toLowerCase();
  }

  private absoluteUrl(href: string): string {
    try {
      return new URL(href, FRAMEWORK_CO_ORIGIN).toString();
    } catch {
      return href;
    }
  }

  /** Human-readable title from a slug, e.g. `senior-software-engineer`. */
  private titleFromSlug(slug: string): string {
    return slug
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
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
