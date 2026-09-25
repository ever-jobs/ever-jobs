import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractJobType,
  parseLocationText,
  resolveCompensation,
} from '@ever-jobs/common';
import {
  ZENNOASTRONAUTICS_CAREERS_URL,
  ZENNOASTRONAUTICS_COMPANY_NAME,
  ZENNOASTRONAUTICS_DEFAULT_TIMEOUT_SECONDS,
  ZENNOASTRONAUTICS_JOBS_GROQ,
  ZENNOASTRONAUTICS_ORIGIN,
  ZENNOASTRONAUTICS_SANITY_QUERY_URL,
} from './zennoastronautics.constants';
import {
  ZennoJobEntry,
  ZennoPortableTextBlock,
  ZennoSanityResponse,
} from './zennoastronautics.types';

@SourcePlugin({
  site: Site.ZENNOASTRONAUTICS,
  name: 'Zenno Astronautics',
  category: 'company',
  companyDomains: ['zennoastronautics.com'],
})
@Injectable()
export class ZennoAstronauticsService implements IScraper {
  private readonly logger = new Logger(ZennoAstronauticsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics(
            'empty',
            'no jobs returned by the Zenno Astronautics Sanity API',
          ),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Zenno Astronautics: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Zenno Astronautics scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout:
        input.requestTimeout ?? ZENNOASTRONAUTICS_DEFAULT_TIMEOUT_SECONDS,
    });

    const url = `${ZENNOASTRONAUTICS_SANITY_QUERY_URL}?query=${encodeURIComponent(
      ZENNOASTRONAUTICS_JOBS_GROQ,
    )}`;
    const res = await client.get<ZennoSanityResponse>(url);
    const entries = Array.isArray(res.data?.result) ? res.data.result : [];
    return entries
      .map((entry) => this.toJobPost(entry))
      .filter((job): job is JobPostDto => job !== null);
  }

  private toJobPost(entry: ZennoJobEntry): JobPostDto | null {
    const title = this.normalize(entry.title);
    if (!title) return null;

    const slug = this.normalize(entry.slug?.current) || this.slugFromTitle(title);
    const parsed = entry.location ? parseLocationText(entry.location) : null;
    const location = parsed?.location ?? null;
    const jobType = extractJobType(
      entry.type ? entry.type.replace(/-/g, ' ') : null,
    );
    const description = this.composeDescription(entry.text);
    const compensation = resolveCompensation({ text: entry.compensation });
    const jobUrl = slug
      ? `${ZENNOASTRONAUTICS_CAREERS_URL}/${slug}`
      : ZENNOASTRONAUTICS_CAREERS_URL;

    return new JobPostDto({
      id: `zennoastronautics-${slug}`,
      atsId: slug,
      site: Site.ZENNOASTRONAUTICS,
      atsType: 'zennoastronautics',
      title,
      companyName: ZENNOASTRONAUTICS_COMPANY_NAME,
      companyUrl: ZENNOASTRONAUTICS_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      applyUrl: jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      jobType,
      ...(entry.type ? { employmentType: entry.type } : {}),
      ...(description ? { description } : {}),
      ...(compensation ? { compensation, salarySource: 'structured' } : {}),
    });
  }

  private composeDescription(blocks?: ZennoPortableTextBlock[]): string {
    if (!blocks?.length) return '';

    const paragraphs: string[] = [];
    for (const block of blocks) {
      const text = this.renderBlock(block);
      if (!text) continue;
      paragraphs.push(block.listItem ? `- ${text}` : text);
    }
    return paragraphs.join('\n\n');
  }

  private renderBlock(block: ZennoPortableTextBlock): string {
    if (!block.children?.length) return '';

    const parts: string[] = [];
    for (const child of block.children) {
      const text = child.text ?? '';
      if (!text) continue;
      const href = this.linkHref(child.marks, block.markDefs);
      parts.push(href ? `${text.trim()} (${href})` : text);
    }
    // trim() already drops trailing newlines; the former /\n+$/ pass was
    // quadratic on text with long inner newline runs (Spec 1689)
    return parts.join('').trim();
  }

  private linkHref(
    marks: string[] | undefined,
    markDefs: ZennoPortableTextBlock['markDefs'],
  ): string | null {
    if (!marks?.length || !markDefs?.length) return null;
    for (const mark of marks) {
      const def = markDefs.find((d) => d._key === mark && d.href);
      if (def?.href) return def.href;
    }
    return null;
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

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(input.resultsWanted, 100);
    return filtered.slice(offset, offset + requested);
  }

  private slugFromTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value
      .split(String.fromCharCode(160))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
