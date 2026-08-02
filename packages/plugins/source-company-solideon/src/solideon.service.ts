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
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  markdownConverter,
  parseLocationList,
  salaryToCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  SOLIDEON_CAREERS_URL,
  SOLIDEON_COMPANY_NAME,
  SOLIDEON_DEFAULT_RESULTS,
  SOLIDEON_DEFAULT_TIMEOUT_SECONDS,
  SOLIDEON_ROLE_HREF_RE,
} from './solideon.constants';
import { SolideonRoleLink } from './solideon.types';

@SourcePlugin({
  site: Site.SOLIDEON,
  name: 'Solideon',
  category: 'company',
})
@Injectable()
export class SolideonService implements IScraper {
  private readonly logger = new Logger(SolideonService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? SOLIDEON_DEFAULT_TIMEOUT_SECONDS,
      });

      const listing = await this.fetchHtml(client, SOLIDEON_CAREERS_URL);
      const links = this.parseListingLinks(listing);
      if (links.length === 0) {
        this.logger.warn('Solideon: no open roles found');
        return new JobResponseDto([]);
      }

      const settled = await Promise.allSettled(
        links.map(async (link) => {
          const detail = await this.fetchHtml(client, link.jobUrl);
          return this.toJobPost(link, detail);
        }),
      );

      const jobs = this.applyInput(
        settled
          .filter(
            (r): r is PromiseFulfilledResult<JobPostDto> =>
              r.status === 'fulfilled',
          )
          .map((r) => r.value),
        input,
      );

      this.logger.log(`Solideon: scraped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(`Solideon scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([]);
    }
  }

  /** GET a page as HTML. Isolated so tests can substitute fixtures per URL. */
  protected async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const res = await client.get<string>(url, { responseType: 'text' });
    return typeof res.data === 'string' ? res.data : '';
  }

  /**
   * Collect the role detail-page links from the careers landing page. Each
   * opening appears as an anchor to `/solideon-<slug>/` (both a titled link and
   * an "Apply" link point to it); keep the titled text and de-dupe by slug.
   */
  private parseListingLinks(html: string): SolideonRoleLink[] {
    const $ = cheerio.load(html);
    const byUrl = new Map<string, SolideonRoleLink>();

    $('a[href]').each((_i, el) => {
      const href = ($(el).attr('href') ?? '').trim();
      if (!SOLIDEON_ROLE_HREF_RE.test(href)) return;
      const jobUrl = href.replace(/\/$/, '');
      const text = this.normalize($(el).text());
      const title = /^apply$/i.test(text) ? '' : text;
      const existing = byUrl.get(jobUrl);
      if (!existing) {
        byUrl.set(jobUrl, { slug: this.slugFromUrl(jobUrl), title, jobUrl });
      } else if (!existing.title && title) {
        existing.title = title;
      }
    });

    return [...byUrl.values()].filter((link) => link.title);
  }

  private toJobPost(link: SolideonRoleLink, detailHtml: string): JobPostDto {
    const $ = cheerio.load(detailHtml);
    const bodyText = this.normalize($('main').text() || $('body').text());

    return new JobPostDto({
      id: `solideon-${link.slug}`,
      site: Site.SOLIDEON,
      title: link.title,
      companyName: SOLIDEON_COMPANY_NAME,
      companyUrl: SOLIDEON_CAREERS_URL,
      jobUrl: link.jobUrl,
      applyUrl: link.jobUrl,
      location: this.location(bodyText),
      isRemote: false,
      description: this.description($),
      compensation: this.compensation(bodyText),
      datePosted: this.datePosted(detailHtml),
      emails: [],
    });
  }

  /**
   * The detail body is the WordPress `<main>` content. Render it to markdown and
   * cut the trailing "TO APPLY FILL OUT THE FORM BELOW" apply section (the
   * Paperform embed) and the redundant leading role-title heading.
   */
  private description($: cheerio.CheerioAPI): string | null {
    const html = $('main').html() ?? $('body').html() ?? '';
    if (!html) return null;
    const markdown = this.collapse(markdownConverter(html) ?? '');
    const cut = markdown.search(/^#*\s*to apply fill out the form below/im);
    const body = cut >= 0 ? markdown.slice(0, cut) : markdown;
    return this.collapse(this.stripLeadingChrome(body)) || null;
  }

  /**
   * Drop the detail page's leading chrome from the rendered markdown: the
   * redundant "2025 <role>" title heading and any thematic-break rules
   * (Elementor dividers) that lead the body.
   */
  private stripLeadingChrome(markdown: string): string {
    const lines = markdown.split('\n');
    while (lines.length) {
      const line = lines[0].trim();
      const isBlank = line === '';
      const isRule = /^[-_*]{3,}$/.test(line);
      const isYearTitle = /^#*\s*20\d{2}\b/.test(line);
      if (isBlank || isRule || isYearTitle) {
        lines.shift();
        continue;
      }
      break;
    }
    return lines.join('\n');
  }

  /**
   * Per-role location from the "Location: <city, state> (On-Site …)" line.
   * Drops the parenthetical, then parses the stated city/state. Returns null
   * when the page states none.
   */
  private location(text: string): LocationDto | null {
    const match = /Location\s*:?\s*([A-Za-z][A-Za-z .,'-]*?)\s*(?:\(|Company Overview|Position Overview|$)/.exec(
      text,
    );
    const value = this.normalize(match?.[1]);
    if (!value) return null;
    return parseLocationList([value]).location ?? null;
  }

  /**
   * Per-role compensation from the "Salary Recommendation: $NNk-$NNk" line.
   * The figures are annual salary ranges, so the interval is stated as yearly.
   * Returns null when the page states no salary — never guessed.
   */
  private compensation(text: string): CompensationDto | null {
    const match = /Salary\s*Recommendation\s*:?\s*(\$[\d][^\n]*?)(?:Location|Company Overview|Position Overview|$)/i.exec(
      text,
    );
    const value = this.normalize(match?.[1]);
    if (!value || !/\d/.test(value)) return null;
    const comp = salaryToCompensation(value, {
      interval: CompensationInterval.YEARLY,
    });
    return comp ?? null;
  }

  /** WordPress publish date from the page's JSON-LD `datePublished`. */
  private datePosted(html: string): Date | string | null {
    const match = /"datePublished"\s*:\s*"([^"]+)"/.exec(html);
    return match ? toDateOnly(match[1]) : null;
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
      SOLIDEON_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromUrl(url: string): string {
    const match = /\/solideon-([a-z0-9-]+)\/?$/i.exec(url);
    return (match?.[1] ?? '').toLowerCase();
  }

  private collapse(body: string): string {
    return body
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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
