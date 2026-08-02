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
  toDateOnly,
} from '@ever-jobs/common';
import {
  SPIKEAEROSPACE_CAREERS_URL,
  SPIKEAEROSPACE_COMPANY_NAME,
  SPIKEAEROSPACE_DEFAULT_RESULTS,
  SPIKEAEROSPACE_DEFAULT_TIMEOUT_SECONDS,
  SPIKEAEROSPACE_OPENINGS_CATEGORY_ID,
  SPIKEAEROSPACE_OPENINGS_CATEGORY_SLUG,
  spikeaerospaceCategoriesUrl,
  spikeaerospacePostsUrl,
} from './spikeaerospace.constants';
import { SpikeRole, WpCategory, WpPost } from './spikeaerospace.types';

@SourcePlugin({
  site: Site.SPIKEAEROSPACE,
  name: 'Spike Aerospace',
  category: 'company',
})
@Injectable()
export class SpikeaerospaceService implements IScraper {
  private readonly logger = new Logger(SpikeaerospaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? SPIKEAEROSPACE_DEFAULT_TIMEOUT_SECONDS,
      });

      const posts = await this.fetchRolePosts(client);
      const roles = this.parseRoles(posts);
      if (roles.length === 0) {
        this.logger.warn('Spike Aerospace: no open roles found');
        return new JobResponseDto([]);
      }

      const jobs = this.applyInput(
        roles.map((role) => this.toJobPost(role)),
        input,
      );

      this.logger.log(`Spike Aerospace: scraped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(
        `Spike Aerospace scrape failed (${this.errorLabel(error)})`,
      );
      return new JobResponseDto([]);
    }
  }

  /**
   * Fetch the open-role posts from the "Current Openings" category via the
   * WordPress REST API: resolve the category id by its slug (falling back to the
   * known id), then read that category's posts. Isolated so tests can substitute
   * captured JSON.
   */
  protected async fetchRolePosts(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<WpPost[]> {
    const categoryId = await this.resolveCategoryId(client);
    const res = await client.get<WpPost[]>(
      spikeaerospacePostsUrl(categoryId),
    );
    return Array.isArray(res.data) ? res.data : [];
  }

  private async resolveCategoryId(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<number> {
    try {
      const res = await client.get<WpCategory[]>(
        spikeaerospaceCategoriesUrl(SPIKEAEROSPACE_OPENINGS_CATEGORY_SLUG),
      );
      const id = Array.isArray(res.data) ? res.data[0]?.id : undefined;
      if (typeof id === 'number' && id > 0) return id;
    } catch (error: unknown) {
      this.logger.warn(
        `Spike Aerospace: category lookup failed (${this.errorLabel(error)})`,
      );
    }
    return SPIKEAEROSPACE_OPENINGS_CATEGORY_ID;
  }

  private parseRoles(posts: WpPost[]): SpikeRole[] {
    const roles: SpikeRole[] = [];
    for (const post of posts) {
      const slug = this.normalize(post.slug);
      const title = this.roleTitle(post.title?.rendered);
      if (!slug || !title) continue;
      roles.push({
        slug,
        jobUrl: this.normalize(post.link) || SPIKEAEROSPACE_CAREERS_URL,
        title,
        description: this.description(post.content?.rendered),
        datePosted: toDateOnly(post.date ?? null),
      });
    }
    return roles;
  }

  /** Decode the post title and drop a leading "Seeking " listing verb. */
  private roleTitle(raw: string | undefined): string {
    const decoded = this.normalize(this.decodeEntities(raw ?? ''));
    return decoded.replace(/^seeking\s+/i, '').trim();
  }

  /**
   * Convert the post body to markdown. The résumé form is injected client-side,
   * so the REST body only leaves a "Contact form not found" placeholder and a
   * dangling "Submit Your Resume:" label — drop both, keep the prose.
   */
  private description(rendered: string | undefined): string | null {
    if (!rendered) return null;
    const $ = cheerio.load(rendered);
    $('[class*="wpcf7"]').remove();
    $('p').each((_i, el) => {
      const text = this.normalize($(el).text());
      if (!text || text === '\u00a0' || /^submit your resume:?$/i.test(text)) {
        $(el).remove();
      }
    });
    const markdown = markdownConverter($('body').html() ?? $.html());
    const body = this.collapse(markdown ?? '');
    return body || null;
  }

  private toJobPost(role: SpikeRole): JobPostDto {
    return new JobPostDto({
      id: `spikeaerospace-${role.slug}`,
      site: Site.SPIKEAEROSPACE,
      title: role.title,
      companyName: SPIKEAEROSPACE_COMPANY_NAME,
      companyUrl: SPIKEAEROSPACE_CAREERS_URL,
      jobUrl: role.jobUrl,
      location: null,
      description: role.description,
      datePosted: role.datePosted,
      emails: [],
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
      SPIKEAEROSPACE_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private decodeEntities(html: string): string {
    return cheerio.load(`<span>${html}</span>`)('span').text();
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
