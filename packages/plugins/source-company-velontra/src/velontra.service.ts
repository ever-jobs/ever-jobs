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
import { createHttpClient, markdownConverter } from '@ever-jobs/common';
import {
  VELONTRA_APPLY_URL,
  VELONTRA_CAREERS_URL,
  VELONTRA_COMPANY_NAME,
  VELONTRA_DEFAULT_RESULTS,
  VELONTRA_DEFAULT_TIMEOUT_SECONDS,
} from './velontra.constants';
import { VelontraRole } from './velontra.types';

@SourcePlugin({
  site: Site.VELONTRA,
  name: 'Velontra',
  category: 'company',
})
@Injectable()
export class VelontraService implements IScraper {
  private readonly logger = new Logger(VelontraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? VELONTRA_DEFAULT_TIMEOUT_SECONDS,
      });

      const html = await this.fetchListingHtml(client);
      const roles = this.parseListing(html);
      if (roles.length === 0) {
        this.logger.warn('Velontra: no open roles found');
        return new JobResponseDto([]);
      }

      const jobs = this.applyInput(
        roles.map((role) => this.toJobPost(role)),
        input,
      );

      this.logger.log(`Velontra: scraped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(`Velontra scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([]);
    }
  }

  /** GET the careers page as HTML. Isolated so tests can substitute a fixture. */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(VELONTRA_CAREERS_URL, {
      responseType: 'text',
    });
    return typeof res.data === 'string' ? res.data : '';
  }

  /**
   * Each open role is a Beaver Builder accordion item: the button label holds
   * the title, the panel holds the full prose. De-dupe by slug.
   */
  private parseListing(html: string): VelontraRole[] {
    const $ = cheerio.load(html);
    const roles: VelontraRole[] = [];
    const seen = new Set<string>();

    $('.fl-accordion-item').each((_i, el) => {
      const item = $(el);
      const title = this.normalize(
        item.find('.fl-accordion-button-label').first().text(),
      );
      if (!title) return;
      const slug = this.slugify(title);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      roles.push({
        slug,
        title,
        description: this.description(item.find('.fl-accordion-content').html()),
      });
    });

    return roles;
  }

  /**
   * Convert the accordion panel to markdown. The panel repeats the title in a
   * leading "Job Title: <title>" heading — drop it, keep the prose.
   */
  private description(rendered: string | null): string | null {
    if (!rendered) return null;
    const $ = cheerio.load(rendered);
    $('h1, h2, h3, h4').each((_i, el) => {
      if (/^job title\s*:/i.test(this.normalize($(el).text()))) {
        $(el).remove();
      }
    });
    const markdown = markdownConverter($('body').html() ?? $.html());
    return this.collapse(markdown ?? '') || null;
  }

  private toJobPost(role: VelontraRole): JobPostDto {
    return new JobPostDto({
      id: `velontra-${role.slug}`,
      site: Site.VELONTRA,
      title: role.title,
      companyName: VELONTRA_COMPANY_NAME,
      companyUrl: VELONTRA_CAREERS_URL,
      jobUrl: VELONTRA_CAREERS_URL,
      location: null,
      description: role.description,
      datePosted: null,
      emails: [],
      applyUrl: VELONTRA_APPLY_URL,
    });
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
      VELONTRA_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugify(value: string): string {
    return this.normalize(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
