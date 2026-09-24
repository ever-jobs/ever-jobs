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
  describeUrlForLog,
  extractEmails,
  extractJobType,
  htmlToPlainText,
  parseLocationText,
  pinUrlToHosts,
} from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import {
  THERMWOOD_ALLOWED_HOSTS,
  THERMWOOD_CARD_SELECTOR,
  THERMWOOD_CAREERS_URL,
  THERMWOOD_COMPANY_NAME,
  THERMWOOD_DATE_SELECTOR,
  THERMWOOD_DEFAULT_TIMEOUT_SECONDS,
  THERMWOOD_DETAILS_SELECTOR,
  THERMWOOD_LOCATION_SELECTOR,
  THERMWOOD_ORIGIN,
  THERMWOOD_TITLE_SELECTOR,
} from './thermwood.constants';
import { ThermwoodJobCard } from './thermwood.types';

@SourcePlugin({
  site: Site.THERMWOOD,
  name: THERMWOOD_COMPANY_NAME,
  category: 'company',
  companyDomains: ['thermwood.com'],
})
@Injectable()
export class ThermwoodService implements IScraper {
  private readonly logger = new Logger(ThermwoodService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job cards on the Thermwood careers page'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Thermwood: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Thermwood scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? THERMWOOD_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: THERMWOOD_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const res = await client.get<string>(careersUrl);
    const cards = this.parseCareersPage(cheerio.load(String(res.data ?? '')));
    return cards
      .map((card) => this.toJobPost(card, careersUrl))
      .filter((job): job is JobPostDto => job !== null);
  }

  /**
   * The careers page to fetch: the caller's `companyUrl` when it is on
   * thermwood.com (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return THERMWOOD_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, THERMWOOD_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Thermwood: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${THERMWOOD_ALLOWED_HOSTS.join(', ')}`,
      );
      return THERMWOOD_CAREERS_URL;
    }
    return pinned;
  }

  private parseCareersPage($: cheerio.CheerioAPI): ThermwoodJobCard[] {
    const cards: ThermwoodJobCard[] = [];
    $(THERMWOOD_CARD_SELECTOR).each((_i, el) => {
      const card = $(el);
      const title = this.normalize(card.find(THERMWOOD_TITLE_SELECTOR).first().text());
      if (!title) return;

      const locationMeta = this.normalize(
        card.find(THERMWOOD_LOCATION_SELECTOR).first().text(),
      );
      const [locationText, typeText] = this.splitLocationMeta(locationMeta);
      const details = card.find(THERMWOOD_DETAILS_SELECTOR).first();

      cards.push({
        title,
        dateText: this.normalize(card.find(THERMWOOD_DATE_SELECTOR).first().text()),
        locationText,
        typeText,
        descriptionHtml: details.html() ?? '',
        descriptionText: htmlToPlainText(details.html() ?? ''),
      });
    });
    return cards;
  }

  private splitLocationMeta(meta: string): [string, string] {
    // "Dale, IN • Full-time" → ["Dale, IN", "Full-time"]
    const parts = meta.split('•').map((p) => p.trim()).filter(Boolean);
    return [parts[0] ?? '', parts.slice(1).join(' • ')];
  }

  private parseDatePosted(dateText: string): Date | null {
    const m = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(dateText);
    if (!m) return null;
    const date = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private toJobPost(card: ThermwoodJobCard, careersUrl: string): JobPostDto | null {
    const slug = this.slugFromTitle(card.title);
    if (!slug) return null;

    const parsed = card.locationText ? parseLocationText(card.locationText) : null;
    const location = parsed?.location ?? null;
    const jobType = card.typeText
      ? extractJobType(card.typeText.replace(/-/g, ' '))
      : null;
    const datePosted = this.parseDatePosted(card.dateText);
    const description = card.descriptionText || null;
    const applyUrl = `${careersUrl}#application-form`;

    return new JobPostDto({
      id: `thermwood-${slug}`,
      atsId: slug,
      site: Site.THERMWOOD,
      atsType: 'thermwood',
      title: card.title,
      companyName: THERMWOOD_COMPANY_NAME,
      companyUrl: THERMWOOD_ORIGIN,
      jobUrl: careersUrl,
      jobUrlDirect: careersUrl,
      applyUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      jobType,
      ...(card.typeText ? { employmentType: card.typeText } : {}),
      ...(description ? { description } : {}),
      ...(datePosted ? { datePosted } : {}),
      emails: extractEmails(card.descriptionText),
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
