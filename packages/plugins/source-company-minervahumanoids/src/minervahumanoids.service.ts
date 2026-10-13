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
import { createHttpClient, parseLocationText } from '@ever-jobs/common';
import {
  MINERVAHUMANOIDS_APPLY_ANCHOR,
  MINERVAHUMANOIDS_COMPANY_NAME,
  MINERVAHUMANOIDS_DEFAULT_TIMEOUT_SECONDS,
  MINERVAHUMANOIDS_ORIGIN,
  MINERVAHUMANOIDS_PUBLISHED_PATH,
  MINERVAHUMANOIDS_TALENT_APPLY_ANCHOR,
} from './minervahumanoids.constants';
import {
  MinervaHumanoidsJob,
  MinervaHumanoidsPayload,
} from './minervahumanoids.types';

@SourcePlugin({
  site: Site.MINERVAHUMANOIDS,
  name: MINERVAHUMANOIDS_COMPANY_NAME,
  category: 'company',
  companyDomains: ['minervahumanoids.com'],
})
@Injectable()
export class MinervaHumanoidsService implements IScraper {
  private readonly logger = new Logger(MinervaHumanoidsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no jobs in the Minerva Humanoids published content'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Minerva Humanoids: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Minerva Humanoids scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? MINERVAHUMANOIDS_DEFAULT_TIMEOUT_SECONDS,
    });

    const origin = this.origin(input.companyUrl);
    const res = await client.get<string>(`${origin}${MINERVAHUMANOIDS_PUBLISHED_PATH}`);
    const payload = this.parsePublished(String(res.data ?? ''));
    const items = Array.isArray(payload?.content?.jobs) ? payload.content.jobs : [];
    return items
      .filter((item) => item.published !== false)
      .map((item) => this.toJobPost(item, origin))
      .filter((job): job is JobPostDto => job !== null);
  }

  /** `published.js` is `window.__minervaContent={…}` — parse the JSON span. */
  private parsePublished(body: string): MinervaHumanoidsPayload | null {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1)) as MinervaHumanoidsPayload;
    } catch {
      return null;
    }
  }

  private toJobPost(item: MinervaHumanoidsJob, origin: string): JobPostDto | null {
    const title = this.normalize(item.title);
    const id = this.normalize(item.id);
    if (!title || !id) return null;

    const externalApply = this.normalize(item.applyUrl);
    const isTalent = item.program === 'talent';
    const jobUrl =
      externalApply || `${origin}/careers#job-description-${id}`;
    const applyUrl =
      externalApply ||
      `${origin}/careers${isTalent ? MINERVAHUMANOIDS_TALENT_APPLY_ANCHOR : MINERVAHUMANOIDS_APPLY_ANCHOR}`;
    const location = item.location ? parseLocationText(item.location).location : null;
    const description = this.buildDescription(item);

    return new JobPostDto({
      id: `minervahumanoids-${id}`,
      atsId: id,
      site: Site.MINERVAHUMANOIDS,
      atsType: 'minervahumanoids',
      title,
      companyName: MINERVAHUMANOIDS_COMPANY_NAME,
      companyUrl: origin,
      jobUrl,
      jobUrlDirect: jobUrl,
      applyUrl,
      location,
      ...(description ? { description } : {}),
    });
  }

  /** `blocks[]` is the role description: paragraphs/headings as text, lists as bullets. */
  private buildDescription(item: MinervaHumanoidsJob): string {
    const parts: string[] = [];
    for (const block of item.blocks ?? []) {
      if (block.kind === 'list') {
        const bullets = (block.items ?? []).map((line) => this.normalize(line)).filter(Boolean);
        if (bullets.length) parts.push(bullets.map((line) => `- ${line}`).join('\n'));
      } else {
        const text = this.normalize(block.text);
        if (text) parts.push(text);
      }
    }
    return parts.join('\n\n');
  }

  /** Origin of `companyUrl` (or the careers URL a caller passed), else default. */
  private origin(companyUrl?: string): string {
    const raw = this.normalize(companyUrl);
    if (!raw) return MINERVAHUMANOIDS_ORIGIN;
    const m = /^(https?:\/\/[^/]+)/i.exec(raw);
    return m ? m[1] : MINERVAHUMANOIDS_ORIGIN;
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

  private nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.split(String.fromCharCode(160)).join(' ').replace(/\s+/g, ' ').trim();
  }
}
