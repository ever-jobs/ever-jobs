import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  DescriptionFormat,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractJobType,
  extractLdJsonBlocks,
  htmlToPlainText,
  jobPostingLdFromNode,
  jobPostingLdToCompensation,
  markdownConverter,
  toDateOnly,
} from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import {
  WERCOMFG_APPLY_MAILTO,
  WERCOMFG_CAREERS_URL,
  WERCOMFG_COMPANY_NAME,
  WERCOMFG_DEFAULT_TIMEOUT_SECONDS,
  WERCOMFG_DETAIL_LINK_RE,
  WERCOMFG_ORIGIN,
} from './wercomfg.constants';
import { WercoDetailLink, WercoPosting } from './wercomfg.types';

/**
 * Werco Manufacturing careers scraper.
 *
 * The `/careers` index is a server-rendered page that links one detail page
 * (`/careers/{slug}`) per role. Each detail page embeds a complete schema.org
 * `JobPosting` JSON-LD block, so the plugin only needs the index's link list —
 * every field comes from structured data. The index itself carries no
 * `JobPosting`, which is why a single-page JSON-LD scrape cannot reach these
 * roles.
 */
@SourcePlugin({
  site: Site.WERCOMFG,
  name: WERCOMFG_COMPANY_NAME,
  category: 'company',
  companyDomains: ['wercomfg.com'],
})
@Injectable()
export class WercoMfgService implements IScraper {
  private readonly logger = new Logger(WercoMfgService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job postings found on the Werco careers pages'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Werco Manufacturing: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Werco Manufacturing scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? WERCOMFG_DEFAULT_TIMEOUT_SECONDS,
    });

    const careersUrl = this.normalize(input.companyUrl) || WERCOMFG_CAREERS_URL;
    const indexRes = await client.get<string>(careersUrl);
    const links = this.collectDetailLinks(cheerio.load(String(indexRes.data ?? '')), careersUrl);
    if (!links.length) return [];

    const settled = await Promise.allSettled(
      links.map((link) => client.get<string>(link.url)),
    );
    const jobs: JobPostDto[] = [];
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') {
        this.logger.warn(`Werco detail fetch failed for ${links[i].url}`);
        return;
      }
      const posting = this.parseDetail(String(result.value.data ?? ''));
      if (!posting) return;
      const job = this.toJobPost(posting, links[i], input.descriptionFormat);
      if (job) jobs.push(job);
    });
    return jobs;
  }

  private collectDetailLinks($: cheerio.CheerioAPI, baseUrl: string): WercoDetailLink[] {
    const seen = new Set<string>();
    const links: WercoDetailLink[] = [];
    $('a[href]').each((_i, el) => {
      const href = ($(el).attr('href') ?? '').trim();
      const absolute = this.absoluteUrl(href, baseUrl);
      if (!absolute) return;
      const path = new URL(absolute).pathname;
      if (!WERCOMFG_DETAIL_LINK_RE.test(path)) return;
      const url = absolute.split('#')[0];
      if (seen.has(url)) return;
      seen.add(url);
      links.push({ url, slug: path.replace(/^\/careers\//, '').replace(/\/+$/, '') });
    });
    return links;
  }

  /** Extract the page's `JobPosting` node plus the raw extras it carries. */
  private parseDetail(html: string): WercoPosting | null {
    const node = this.findJobPostingNode(extractLdJsonBlocks(html));
    if (!node) return null;
    const posting = jobPostingLdFromNode(node);
    if (!posting) return null;
    return {
      posting,
      identifier: this.propertyValue(node.identifier),
      industry: this.asString(node.industry),
      occupationalCategory: this.asString(node.occupationalCategory),
      workHours: this.asString(node.workHours),
    };
  }

  private toJobPost(
    { posting, identifier, industry, occupationalCategory, workHours }: WercoPosting,
    link: WercoDetailLink,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const title = this.normalize(posting.title);
    if (!title) return null;
    const atsId = this.normalize(identifier) || link.slug;
    if (!atsId) return null;
    const jobUrl = this.normalize(posting.url) || link.url;
    const description = this.composeDescription(
      this.formatDescription(posting.description, format),
      industry,
      occupationalCategory,
      workHours,
    );
    const loc = posting.locations[0] ?? null;
    const location = loc && (loc.city || loc.region || loc.country)
      ? new LocationDto({ city: loc.city ?? undefined, state: loc.region ?? undefined, country: loc.country ?? undefined })
      : null;
    const employmentType = this.normalize(posting.employmentType);

    return new JobPostDto({
      id: `wercomfg-${atsId}`,
      atsId,
      site: Site.WERCOMFG,
      atsType: 'wercomfg',
      title,
      companyName: this.normalize(posting.hiringOrganizationName) || WERCOMFG_COMPANY_NAME,
      companyUrl: WERCOMFG_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      applyUrl: this.normalize(posting.applyUrl) || WERCOMFG_APPLY_MAILTO,
      jobType: employmentType ? extractJobType(employmentType.replace(/[_-]/g, ' ')) ?? null : null,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(description ? { description } : {}),
      datePosted: posting.datePosted ? toDateOnly(posting.datePosted) : null,
      isRemote: posting.remote,
      employmentType: employmentType || null,
      compensation: jobPostingLdToCompensation(posting.baseSalary),
    });
  }

  /** Walk parsed ld+json blocks for the first `JobPosting` node (handles `@graph`/`ItemList` containers). */
  private findJobPostingNode(value: unknown): Record<string, unknown> | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findJobPostingNode(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const node = value as Record<string, unknown>;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')) {
      return node;
    }
    for (const key of ['@graph', 'itemListElement', 'item']) {
      if (node[key] !== undefined) {
        const found = this.findJobPostingNode(node[key]);
        if (found) return found;
      }
    }
    return null;
  }

  /** A schema `PropertyValue` (or bare string) → its `value`. */
  private propertyValue(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) {
      const v = (value as Record<string, unknown>).value;
      return typeof v === 'string' ? v : null;
    }
    return null;
  }

  /** Schema values arrive as string, `{name}` object, or arrays of either. */
  private asString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const parts = value.map((v) => this.asString(v)).filter((v): v is string => !!v);
      return parts.length ? parts.join(', ') : null;
    }
    if (typeof value === 'object' && value !== null) {
      return this.asString((value as Record<string, unknown>).name);
    }
    return null;
  }

  private composeDescription(
    body: string | null,
    industry: string | null,
    occupationalCategory: string | null,
    workHours: string | null,
  ): string | null {
    const meta: string[] = [];
    if (industry) meta.push(`Industry: ${industry}`);
    if (occupationalCategory) meta.push(`Category: ${occupationalCategory}`);
    if (workHours) meta.push(`Shift: ${workHours}`);
    const parts = [body, meta.length ? meta.join('\n') : null].filter(
      (p): p is string => !!p,
    );
    return parts.length ? parts.join('\n\n') : null;
  }

  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  private absoluteUrl(href: string, baseUrl: string): string | null {
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
      return null;
    }
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return null;
    }
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.description, job.location?.city, job.location?.state].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
      );
    }

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(input.resultsWanted, 100);
    return filtered.slice(offset, offset + requested);
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.split(String.fromCharCode(160)).join(' ').replace(/\s+/g, ' ').trim();
  }
}
