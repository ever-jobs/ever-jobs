import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import { classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, parseLocationList } from '@ever-jobs/common';
import {
  CANEKAST_CAREERS_URL,
  CANEKAST_COMPANY_NAME,
  CANEKAST_DEFAULT_RESULTS,
  CANEKAST_DEFAULT_TIMEOUT_SECONDS,
  CANEKAST_PDF_MAX_BYTES,
  CANEKAST_PDF_CONCURRENCY,
  CANEKAST_ORIGIN,
  CANEKAST_PDF_HREF_RE,
  canekastLetterheadRe,
} from './canekast.constants';
import { extractPdfText } from './canekast.pdf';
import { CanekastOpening } from './canekast.types';

@SourcePlugin({
  site: Site.CANEKAST,
  name: 'CaneKast',
  category: 'company',
})
@Injectable()
export class CanekastService implements IScraper {
  private readonly logger = new Logger(CanekastService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? CANEKAST_DEFAULT_TIMEOUT_SECONDS,
      });

      const html = await this.fetchListingHtml(client);
      const openings = this.parseListing(html);
      if (openings.length === 0) {
        this.logger.warn('CaneKast: no openings found on the careers page');
        return new JobResponseDto([]);
      }

      // Bounded worker pool. The previous `Promise.allSettled(openings.map(...))`
      // fetched and decoded EVERY PDF simultaneously, so peak memory scaled with
      // the size of the listing rather than with anything we control. Workers
      // pull from a shared cursor, so at most CANEKAST_PDF_CONCURRENCY PDFs are
      // resident at once. Results are written by index, so ordering is
      // identical to the previous implementation.
      const collected: (JobPostDto | undefined)[] = new Array(openings.length);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (let i = cursor++; i < openings.length; i = cursor++) {
          const opening = openings[i];
          let text = '';
          try {
            text = await this.fetchPdfText(client, opening.pdfUrl);
          } catch (error: unknown) {
            // Unchanged semantics: a failed fetch still yields a post, just
            // without the description body.
            this.logger.warn(
              `CaneKast: PDF fetch/parse failed for ${opening.pdfUrl} (${this.errorLabel(error)})`,
            );
          }
          try {
            collected[i] = this.toJobPost(opening, text);
          } catch (error: unknown) {
            // Matches the old `.filter(status === 'fulfilled')`: a posting that
            // cannot be mapped is dropped rather than failing the whole scrape.
            this.logger.warn(
              `CaneKast: could not map ${opening.pdfUrl} (${this.errorLabel(error)})`,
            );
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(CANEKAST_PDF_CONCURRENCY, openings.length) },
          () => worker(),
        ),
      );

      const jobs = collected.filter((j): j is JobPostDto => j !== undefined);

      const out = this.applyInput(jobs, input);
      this.logger.log(`CaneKast: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(`CaneKast scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([], classifyScrapeError(error));
    }
  }

  /**
   * Fetch the careers listing HTML. The page is server-rendered plain HTML, so
   * a plain HTTP GET is sufficient. Isolated so tests can substitute captured
   * HTML.
   */
  protected async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
  ): Promise<string> {
    const res = await client.get<string>(CANEKAST_CAREERS_URL, {
      responseType: 'text',
    });
    return typeof res.data === 'string' ? res.data : '';
  }

  /**
   * Fetch a role's PDF over plain HTTP (the PDFs are unauthenticated) and
   * extract its text. Isolated so tests can substitute text.
   */
  protected async fetchPdfText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const res = await client.get<ArrayBuffer | Uint8Array>(url, {
      responseType: 'arraybuffer',
      // Refuse an oversized PDF at the transport layer, not after the whole
      // body is already resident. See CANEKAST_PDF_MAX_BYTES.
      maxContentLength: CANEKAST_PDF_MAX_BYTES,
      maxBodyLength: CANEKAST_PDF_MAX_BYTES,
    });
    return extractPdfText(res.data);
  }

  /**
   * Parse the careers listing: each open role is an anchor to a
   * `/wp-content/uploads/*.pdf`. The visible anchor text is the role title; the
   * page also carries a duplicate anchor whose text is the file name, so a
   * trailing `.pdf` is stripped and roles are de-duplicated by PDF URL.
   */
  private parseListing(html: string): CanekastOpening[] {
    const $ = cheerio.load(html);

    const seen = new Set<string>();
    const openings: CanekastOpening[] = [];
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      if (!CANEKAST_PDF_HREF_RE.test(href)) return;

      const pdfUrl = this.absoluteUrl(href);
      if (seen.has(pdfUrl)) return;

      const title = this.titleFromAnchor($(el).text(), pdfUrl);
      if (!title) return;

      seen.add(pdfUrl);
      openings.push({ title, pdfUrl });
    });

    return openings;
  }

  private toJobPost(opening: CanekastOpening, pdfText: string): JobPostDto {
    const slug = this.slugFromPdfUrl(opening.pdfUrl);

    const location = this.locationFromText(pdfText);
    const description =
      pdfText.replace(canekastLetterheadRe(), ' ').replace(/\s+\n/g, '\n').trim() ||
      null;

    return new JobPostDto({
      id: `canekast-${slug}`,
      site: Site.CANEKAST,
      title: opening.title,
      companyName: CANEKAST_COMPANY_NAME,
      companyUrl: CANEKAST_CAREERS_URL,
      jobUrl: opening.pdfUrl,
      location,
      description,
      isRemote: false,
      datePosted: null,
      emails: [],
      applyUrl: CANEKAST_CAREERS_URL,
    });
  }

  /**
   * Role location from a PDF's letterhead address (identical across roles),
   * e.g. `Chaska, MN`. Returns null when no address is present.
   */
  private locationFromText(text: string): LocationDto | null {
    const match = canekastLetterheadRe().exec(text);
    if (!match) return null;
    const city = this.normalize(match[1]);
    const state = this.normalize(match[2]);
    if (!city || !state) return null;
    return parseLocationList([`${city}, ${state}`]).location;
  }

  /** Clean a listing anchor's text into a title, dropping a trailing `.pdf`. */
  private titleFromAnchor(raw: string, pdfUrl: string): string {
    const text = this.normalize(raw).replace(/\.pdf$/i, '');
    if (text) return text;
    return this.slugFromPdfUrl(pdfUrl)
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ')
      .trim();
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
      CANEKAST_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugFromPdfUrl(url: string): string {
    const file = url.split(/[?#]/)[0].split('/').pop() ?? '';
    return (
      file
        .replace(/\.pdf$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'role'
    );
  }

  private absoluteUrl(href: string): string {
    try {
      return new URL(href, CANEKAST_ORIGIN).toString();
    } catch {
      return href;
    }
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
