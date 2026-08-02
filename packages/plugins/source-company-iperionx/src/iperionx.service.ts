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
  IPERIONX_APPLY_LINK_MATCH,
  IPERIONX_CAREERS_URL,
  IPERIONX_COMPANY_NAME,
  IPERIONX_DEFAULT_RESULTS,
  IPERIONX_DEFAULT_TIMEOUT_SECONDS,
  IPERIONX_INDEED_JOB_PATH,
} from './iperionx.constants';
import { IperionxOpening } from './iperionx.types';

/**
 * IperionX careers scraper.
 *
 * The careers page is a **summary-only** WordPress board: one page lists every
 * role with just a title, a short blurb, and an "Apply Now" link to an Indeed
 * job page. There is no detail page on-domain to fetch and Indeed is explicitly
 * not scraped, so this is a single fetch with no per-role fan-out. Many fields
 * are intentionally empty because the site simply does not state them.
 */
@SourcePlugin({
  site: Site.IPERIONX,
  name: 'IperionX',
  category: 'company',
})
@Injectable()
export class IperionxService implements IScraper {
  private readonly logger = new Logger(IperionxService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? IPERIONX_DEFAULT_TIMEOUT_SECONDS,
      });

      const html = await this.fetchListingHtml(client);
      const openings = this.parseListing(html);
      if (openings.length === 0) {
        this.logger.warn('IperionX: no roles found on the careers page');
        return new JobResponseDto([]);
      }

      const jobs = openings.map((opening) => this.toJobPost(opening));
      const out = this.applyInput(jobs, input);
      this.logger.log(`IperionX: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`IperionX scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Fetch the careers page HTML. Server-rendered WordPress — plain HTTP, no
   * headless browser. Isolated so tests can substitute captured HTML.
   */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(IPERIONX_CAREERS_URL);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  /**
   * Parse the "Current Openings" board. Each real role card contains an
   * "Apply Now" anchor to an `indeed.com/job/{slug}` URL; we anchor on those
   * (which naturally skips the section header and the newsletter blocks), then
   * read the title and blurb from the same card. Deduped by Indeed slug.
   */
  private parseListing(html: string): IperionxOpening[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const openings: IperionxOpening[] = [];

    $(`a[href*="${IPERIONX_APPLY_LINK_MATCH}"]`).each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const slug = this.slugFromHref(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const card = $(el).closest('.pr-10.py-10');
      const rawTitle = this.normalize(card.find('h3').first().text());
      if (!rawTitle) return;
      const { title, location } = this.splitTitleLocation(rawTitle);

      const blurb = card.find('.subheading').first();
      const description = blurb.length
        ? markdownConverter(blurb.html() ?? null)
        : null;

      openings.push({
        slug,
        title,
        applyUrl: href,
        location,
        description,
      });
    });

    return openings;
  }

  private toJobPost(opening: IperionxOpening): JobPostDto {
    // The role's only location signal is a bare US state (e.g. `Virginia`), so
    // opt into `allowBareStateProvince` to file it as `{ state: 'VA' }` instead
    // of a city (Spec 5060).
    const parsed = opening.location
      ? parseLocationList([opening.location], { allowBareStateProvince: true })
      : null;

    return new JobPostDto({
      id: `iperionx-${opening.slug}`,
      site: Site.IPERIONX,
      title: opening.title || opening.slug,
      companyName: IPERIONX_COMPANY_NAME,
      companyUrl: IPERIONX_CAREERS_URL,
      jobUrl: opening.applyUrl,
      applyUrl: opening.applyUrl,
      location: parsed?.location ?? null,
      description: opening.description,
      isRemote: parsed?.remoteMentioned ?? false,
      ...(parsed?.workFromHomeType
        ? { workFromHomeType: parsed.workFromHomeType }
        : {}),
      datePosted: null,
      emails: [],
    });
  }

  /**
   * Split a displayed title like `Production Supervisor - Night - Virginia`
   * into `{ title: 'Production Supervisor - Night', location: 'Virginia' }`.
   * The site tags every role with a trailing " - {location}"; when no such
   * suffix is present the whole string is the title and location is null.
   */
  private splitTitleLocation(rawTitle: string): {
    title: string;
    location: string | null;
  } {
    const parts = rawTitle.split(/\s+-\s+/);
    if (parts.length < 2) return { title: rawTitle, location: null };
    const location = parts[parts.length - 1].trim() || null;
    const title = parts.slice(0, -1).join(' - ').trim();
    return { title: title || rawTitle, location };
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
      IPERIONX_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromHref(href: string): string {
    const path = href.split(/[?#]/)[0];
    const idx = path.indexOf(IPERIONX_INDEED_JOB_PATH);
    const tail =
      idx >= 0 ? path.slice(idx + IPERIONX_INDEED_JOB_PATH.length) : '';
    return tail.replace(/\/+$/, '').toLowerCase();
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
