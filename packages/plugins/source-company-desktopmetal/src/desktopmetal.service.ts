import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  CompensationDto,
  CompensationInterval,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  BrowserPool,
  createHttpClient,
  extractEmails,
  parseLocationList,
  salaryToCompensation,
} from '@ever-jobs/common';
import {
  DESKTOPMETAL_CAREERS_URL,
  DESKTOPMETAL_COMPANY_NAME,
  DESKTOPMETAL_DEFAULT_RESULTS,
  DESKTOPMETAL_DEFAULT_TIMEOUT_SECONDS,
  DESKTOPMETAL_PDF_MAX_BYTES,
  DESKTOPMETAL_PDF_CONCURRENCY,
  DESKTOPMETAL_ORIGIN,
  DESKTOPMETAL_PAY_INTERVALS,
} from './desktopmetal.constants';
import { extractPdfText } from './desktopmetal.pdf';
import { DesktopmetalOpening, DesktopmetalPay } from './desktopmetal.types';

@SourcePlugin({
  site: Site.DESKTOPMETAL,
  name: 'Desktop Metal',
  category: 'company',
})
@Injectable()
export class DesktopmetalService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(DesktopmetalService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const html = await this.fetchListingHtml(input);
      const { openings, applyEmail } = this.parseListing(html);
      if (openings.length === 0) {
        this.logger.warn('Desktop Metal: no openings found on the careers page');
        return new JobResponseDto([]);
      }

      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? DESKTOPMETAL_DEFAULT_TIMEOUT_SECONDS,
      });

      // Bounded worker pool. The previous `Promise.allSettled(openings.map(...))`
      // fetched and decoded EVERY PDF simultaneously, so peak memory scaled with
      // the size of the listing rather than with anything we control. Workers
      // pull from a shared cursor, so at most DESKTOPMETAL_PDF_CONCURRENCY PDFs are
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
              `Desktop Metal: PDF fetch/parse failed for ${opening.pdfUrl} (${this.errorLabel(error)})`,
            );
          }
          try {
            collected[i] = this.toJobPost(opening, text, applyEmail);
          } catch (error: unknown) {
            // Matches the old `.filter(status === 'fulfilled')`: a posting that
            // cannot be mapped is dropped rather than failing the whole scrape.
            this.logger.warn(
              `Desktop Metal: could not map ${opening.pdfUrl} (${this.errorLabel(error)})`,
            );
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(DESKTOPMETAL_PDF_CONCURRENCY, openings.length) },
          () => worker(),
        ),
      );

      const jobs = collected.filter((j): j is JobPostDto => j !== undefined);

      const out = this.applyInput(jobs, input);
      this.logger.log(`Desktop Metal: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      this.logger.error(
        `Desktop Metal scrape failed (${this.errorLabel(error)})`,
      );
      return new JobResponseDto([]);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  /**
   * Fetch the careers listing HTML. The page is client-rendered and sits behind
   * a Cloudflare managed challenge, so it is loaded with a stealth headless
   * browser (a real browser clears the challenge automatically). A proxy is
   * used when supplied. Isolated so tests can substitute captured HTML.
   */
  protected async fetchListingHtml(input: ScraperInputDto): Promise<string> {
    const proxy = input.proxies?.[0];
    const timeoutMs =
      (input.requestTimeout ?? DESKTOPMETAL_DEFAULT_TIMEOUT_SECONDS) * 1000;
    const page = await BrowserPool.getPage({ proxy, stealth: true });
    try {
      await page.goto(DESKTOPMETAL_CAREERS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      await page
        .waitForSelector('a[href*="/uploads/"][href$=".pdf"]', {
          timeout: timeoutMs,
        })
        .catch(() => undefined);
      return await page.content();
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Fetch a role's PDF over plain HTTP (the PDFs are unauthenticated and not
   * challenged) and extract its text. Isolated so tests can substitute text.
   */
  protected async fetchPdfText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const res = await client.get<ArrayBuffer | Uint8Array>(url, {
      responseType: 'arraybuffer',
      // Refuse an oversized PDF at the transport layer, not after the whole
      // body is already resident. See DESKTOPMETAL_PDF_MAX_BYTES.
      maxContentLength: DESKTOPMETAL_PDF_MAX_BYTES,
      maxBodyLength: DESKTOPMETAL_PDF_MAX_BYTES,
    });
    return extractPdfText(res.data);
  }

  /**
   * Parse the careers listing: each open role is an anchor to a `/uploads/*.pdf`
   * whose text is `Title - Location`, grouped under a department `<h3>`. The
   * apply address is the page's global `mailto:` link.
   */
  private parseListing(html: string): {
    openings: DesktopmetalOpening[];
    applyEmail: string | null;
  } {
    const $ = cheerio.load(html);

    const seen = new Set<string>();
    const openings: DesktopmetalOpening[] = [];
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      if (!/\/uploads\/[^"'\s]+\.pdf(?:[?#]|$)/i.test(href)) return;

      const text = this.normalize($(el).text());
      const parts = text.match(/^(.*\S)\s+[-\u2012-\u2015\u2212]\s+(.+)$/);
      if (!parts) return;

      const pdfUrl = this.absoluteUrl(href);
      if (seen.has(pdfUrl)) return;
      seen.add(pdfUrl);

      // nearest preceding non-empty <h3> is the department heading
      const paragraph = $(el).closest('p');
      const base = paragraph.length ? paragraph : $(el);
      let department: string | null = null;
      base.prevAll('h3').each((_j, h3) => {
        if (department) return;
        const label = this.normalize($(h3).text());
        if (label) department = label;
      });

      openings.push({
        title: this.normalize(parts[1]),
        location: this.normalize(parts[2]),
        department,
        pdfUrl,
      });
    });

    const mails = $('a[href^="mailto:" i]')
      .toArray()
      .map((el) =>
        ($(el).attr('href') ?? '')
          .replace(/^mailto:/i, '')
          .split('?')[0]
          .trim()
          .toLowerCase(),
      )
      .filter((m) => m.includes('@'));
    const applyEmail =
      mails.find((m) => /@(?:[a-z0-9-]+\.)*desktopmetal\.com$/i.test(m)) ??
      mails[0] ??
      null;

    return { openings, applyEmail };
  }

  private toJobPost(
    opening: DesktopmetalOpening,
    pdfText: string,
    applyEmail: string | null,
  ): JobPostDto {
    const slug = this.slugFromPdfUrl(opening.pdfUrl);
    const description = pdfText.trim() || null;

    const pay = this.payFromText(pdfText);
    const compensation: CompensationDto | null = pay.text
      ? salaryToCompensation(
          pay.text,
          pay.interval ? { interval: pay.interval } : undefined,
        )
      : null;

    const parsed = parseLocationList([opening.location || null]);
    const location: LocationDto | null = opening.location
      ? parsed.location
      : null;

    const employmentType = this.detectEmploymentType(pdfText);
    const jobType = employmentType
      ? getJobTypeFromString(employmentType)
      : null;

    const emails = applyEmail
      ? [applyEmail]
      : (extractEmails(pdfText) ?? []);

    return new JobPostDto({
      id: `desktopmetal-${slug}`,
      site: Site.DESKTOPMETAL,
      title: opening.title,
      companyName: DESKTOPMETAL_COMPANY_NAME,
      companyUrl: DESKTOPMETAL_CAREERS_URL,
      jobUrl: opening.pdfUrl,
      ...(opening.department ? { department: opening.department } : {}),
      location,
      description,
      isRemote: opening.location ? parsed.remoteMentioned : null,
      ...(parsed.workFromHomeType
        ? { workFromHomeType: parsed.workFromHomeType }
        : {}),
      ...(employmentType ? { employmentType } : {}),
      ...(jobType ? { jobType: [jobType] } : {}),
      ...(compensation ? { compensation } : {}),
      datePosted: null,
      // Apply is by email; the address lives in `emails`. `applyUrl` is left
      // unset (a mailto: is not a web URL, and there is no on-site apply page).
      emails,
    });
  }

  /**
   * Extract the pay range and its authoritative interval from a role's PDF. The
   * interval comes from the explicit "Hourly Range" / "Salary Range" label (or a
   * per-unit token as a fallback) and is passed to the shared salary parser so
   * the amount's magnitude never has to guess it (Spec 5045 `interval` hint).
   */
  private payFromText(text: string): DesktopmetalPay {
    const norm = text.replace(/\u00a0/g, ' ');
    const interval = this.detectInterval(norm);
    const region = this.payRegion(norm) ?? norm;

    const match = region.match(
      /\$\s?\d[\d.,]*\s*(?:-|\u2012|\u2013|\u2014|\u2015|\u2212|to)\s*\$?\s?\d[\d.,]*/i,
    );
    if (!match) return { text: null, interval };

    const cleaned = match[0]
      .replace(/[\u2012-\u2015\u2212]/g, '-')
      .replace(/,(?!\d)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { text: cleaned, interval };
  }

  /** Slice around a pay label so the first `$` range found is the real one. */
  private payRegion(text: string): string | null {
    const label = text.match(/(?:hourly|salary|pay)\s+range/i);
    if (!label || label.index === undefined) return null;
    return text.slice(label.index, label.index + 200);
  }

  private detectInterval(text: string): CompensationInterval | undefined {
    if (/hourly\s+range|per\s+hour|\/\s*hr\b|\bhourly\b/i.test(text)) {
      return CompensationInterval.HOURLY;
    }
    if (
      /salary\s+range|per\s+(?:year|annum)|\/\s*yr\b|\bannually\b|\byearly\b/i.test(
        text,
      )
    ) {
      return CompensationInterval.YEARLY;
    }
    for (const [pattern, interval] of DESKTOPMETAL_PAY_INTERVALS) {
      if (pattern.test(text)) return interval;
    }
    return undefined;
  }

  private detectEmploymentType(text: string): string | null {
    if (/\bfull[-\s]?time\b/i.test(text)) return 'Full-time';
    if (/\bpart[-\s]?time\b/i.test(text)) return 'Part-time';
    if (/\b(?:contract|contractor)\b/i.test(text)) return 'Contract';
    if (/\b(?:intern|internship)\b/i.test(text)) return 'Internship';
    if (/\btemporary\b/i.test(text)) return 'Temporary';
    return null;
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
      DESKTOPMETAL_DEFAULT_RESULTS,
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
      return new URL(href, DESKTOPMETAL_ORIGIN).toString();
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
