import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  CompensationDto,
  CompensationInterval,
  Country,
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
  createHttpClient,
  markdownConverter,
  parseLocationText,
  stripParentheticals,
} from '@ever-jobs/common';
import {
  ARGOSPACE_CAREERS_URL,
  ARGOSPACE_COMPANY_NAME,
  ARGOSPACE_DEFAULT_RESULTS,
  ARGOSPACE_DEFAULT_TIMEOUT_SECONDS,
  ARGOSPACE_ORIGIN,
  argospaceLocationHeuristicsEnabled,
} from './argospace.constants';

interface JobRef {
  title: string;
  jobUrl: string;
}

interface ParsedSpecs {
  employmentType: string;
  location: string;
  salary: string;
}

@SourcePlugin({
  site: Site.ARGOSPACE,
  name: 'Argo Space',
  category: 'company',
  companyDomains: ['argospace.com'],
})
@Injectable()
export class ArgospaceService implements IScraper {
  private readonly logger = new Logger(ArgospaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      this.logger.log(`Argo Space: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Argo Space scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? ARGOSPACE_DEFAULT_TIMEOUT_SECONDS,
    });

    const fetchUrl = input.companyUrl || ARGOSPACE_CAREERS_URL;
    const companyUrl = input.companyUrl || ARGOSPACE_ORIGIN;
    const startRes = await client.get<string>(fetchUrl);
    const $ = cheerio.load(startRes.data);
    const refs = this.parseCareersList($, fetchUrl);
    if (refs.length === 0) {
      throw new Error('Argo Space careers page is missing the Current Openings list');
    }

    const jobs: JobPostDto[] = [];
    for (const ref of refs) {
      const job = await this.fetchDetail(client, ref, companyUrl);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private parseCareersList($: cheerio.CheerioAPI, baseUrl: string): JobRef[] {
    const refs: JobRef[] = [];
    const seen = new Set<string>();
    $('.careers-list-2 .careers-item-2 a.career-box[href^="/careers/"]').each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href')?.trim();
      const title = this.normalize($a.find('h2.jobtitletxt').first().text());
      if (href && title && !seen.has(href)) {
        seen.add(href);
        refs.push({
          title,
          jobUrl: this.resolveUrl(href, baseUrl),
        });
      }
    });
    return refs;
  }

  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    ref: JobRef,
    companyUrl: string,
  ): Promise<JobPostDto | null> {
    const res = await client.get<string>(ref.jobUrl);
    const $ = cheerio.load(res.data);
    const title = this.extractTitle($) || ref.title;
    if (!title) return null;

    const specs = this.extractSpecs($);
    const applyUrl = this.extractApplyUrl($, ref.jobUrl);
    const location = this.parseLocation(specs.location);
    const compensation = this.parseCompensation(specs.salary);
    const description = this.extractDescription($);
    const { jobTypes, employmentType } = this.parseJobTypes(specs.employmentType);

    const slug = this.slugFromUrl(ref.jobUrl);
    return new JobPostDto({
      id: `argospace-${slug}`,
      site: Site.ARGOSPACE,
      title,
      companyName: ARGOSPACE_COMPANY_NAME,
      companyUrl: companyUrl || ARGOSPACE_ORIGIN,
      jobUrl: ref.jobUrl,
      jobUrlDirect: ref.jobUrl,
      applyUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      description,
      compensation,
      isRemote: false,
      workFromHomeType: 'On Site',
      jobType: jobTypes,
      employmentType,
    });
  }

  private extractTitle($: cheerio.CheerioAPI): string | null {
    const text = this.normalize($('h1.heading-6').first().text());
    return text || null;
  }

  private extractSpecs($: cheerio.CheerioAPI): ParsedSpecs {
    const specs: ParsedSpecs = { employmentType: '', location: '', salary: '' };
    const specDiv = $('div.spec_div').first();
    if (!specDiv.length) return specs;

    specDiv.find('div.spec_txt').each((_, el) => {
      const text = this.normalize($(el).text());
      if (!text || text.toLowerCase().startsWith('specification')) return;

      if (this.isSalaryText(text) && !specs.salary) {
        specs.salary = text;
      } else if (this.isLocationText(text) && !specs.location) {
        specs.location = text;
      } else if (this.isEmploymentTypeText(text) && !specs.employmentType) {
        specs.employmentType = text;
      }
    });

    return specs;
  }

  private isEmploymentTypeText(text: string): boolean {
    if (text.includes('$')) return false;
    return getJobTypeFromString(text) !== null;
  }

  private isLocationText(text: string): boolean {
    if (text.includes('$')) return false;
    if (/,\s*[A-Za-z]{2}\b/.test(text)) return true;
    if (/\b(?:on-site|on site|remote|hybrid)\b/i.test(text)) return true;
    return false;
  }

  private isSalaryText(text: string): boolean {
    if (text.includes('$')) return true;
    if (/\d+\s*(?:k|hr|hour|hours|day|week|month|year|annually|annual)/i.test(text)) return true;
    return false;
  }

  private extractApplyUrl($: cheerio.CheerioAPI, jobUrl: string): string | null {
    const link = $('a.button')
      .filter((_, el) => {
        const text = this.normalize($(el).text()).toLowerCase();
        return text.includes('apply');
      })
      .first();
    const href = link.attr('href')?.trim();
    return href ? this.resolveUrl(href, jobUrl) : null;
  }

  private extractDescription($: cheerio.CheerioAPI): string | null {
    const html = $('div.w-richtext').first().html();
    if (!html) return null;
    return markdownConverter(html);
  }

  private parseLocation(raw: string): LocationDto | null {
    const text = this.normalize(raw);
    if (!text) return null;
    if (!argospaceLocationHeuristicsEnabled()) return parseLocationText(text).location;

    // Spec 1689 — pre-5125 Argo Space heuristics (ARGOSPACE_LOCATION_HEURISTICS
    // =false turns them off): strip parenthetical qualifiers ("(On-site)")
    // before parsing, falling back to the full label when the parenthetical is
    // the geography; then fill a missing country with Country.USA, since Argo
    // Space hires in the US only. Parsed fields always win.
    // linear strip (the former /\([^)]*\)/g rescanned to the end from every
    // unclosed '('); the stripped probe skips the parser's legacy Remote city
    // so 'Remote (Austin, TX)' still falls back to Austin
    const stripped = this.normalize(stripParentheticals(text, ''));
    const location =
      (stripped && stripped !== text
        ? parseLocationText(stripped, { emitRemoteCity: false }).location
        : null) ??
      parseLocationText(text).location ??
      new LocationDto({});
    if (!location.country) location.country = Country.USA;
    return location;
  }

  private parseCompensation(raw: string): CompensationDto | null {
    const text = this.normalize(raw);
    if (!text) return null;

    const values: number[] = [];
    const tokens = text
      .split(/[\s\-+–—]+/)
      .filter(Boolean)
      .map((token) => token.replace(/[,]/g, ''));

    for (const token of tokens) {
      const amount = this.parseAmount(token);
      if (amount !== null) values.push(amount);
    }

    if (values.length === 0) return null;

    const interval = this.inferCompensationInterval(text);
    return new CompensationDto({
      interval,
      minAmount: Math.min(...values),
      maxAmount: Math.max(...values),
      currency: 'USD',
    });
  }

  private parseAmount(token: string): number | null {
    const lower = token.toLowerCase();
    if (lower.includes('k')) {
      const match = lower.match(/([\d.]+)\s*k/);
      if (match) {
        const value = Number(match[1]);
        return Number.isFinite(value) ? value * 1000 : null;
      }
    }

    const numericMatch = token.match(/([\d.]+)/);
    if (!numericMatch) return null;
    const value = Number(numericMatch[1]);
    return Number.isFinite(value) ? value : null;
  }

  private inferCompensationInterval(text: string): CompensationInterval {
    const lower = text.toLowerCase();
    if (lower.includes('hour') || lower.includes('hr')) return CompensationInterval.HOURLY;
    if (lower.includes('month')) return CompensationInterval.MONTHLY;
    if (lower.includes('week')) return CompensationInterval.WEEKLY;
    if (lower.includes('day')) return CompensationInterval.DAILY;
    return CompensationInterval.YEARLY;
  }

  private parseJobTypes(raw: string): { jobTypes: JobType[] | null; employmentType: string | null } {
    const text = this.normalize(raw);
    if (!text) return { jobTypes: null, employmentType: null };

    const first = text.split(/[;\/]/)[0].trim();
    const type = getJobTypeFromString(first);
    if (!type) {
      return { jobTypes: null, employmentType: text };
    }

    const labels: Record<JobType, string> = {
      [JobType.FULL_TIME]: 'Full-Time',
      [JobType.PART_TIME]: 'Part-Time',
      [JobType.CONTRACT]: 'Contract',
      [JobType.TEMPORARY]: 'Temporary',
      [JobType.INTERNSHIP]: 'Internship',
      [JobType.PER_DIEM]: 'Per Diem',
      [JobType.NIGHTS]: 'Nights',
      [JobType.OTHER]: 'Other',
      [JobType.SUMMER]: 'Summer',
      [JobType.VOLUNTEER]: 'Volunteer',
    };

    return { jobTypes: [type], employmentType: labels[type] ?? text };
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
    const requested = this.nonNegativeInt(input.resultsWanted, ARGOSPACE_DEFAULT_RESULTS);
    return filtered.slice(offset, offset + requested);
  }

  private resolveUrl(href: string, base: string): string {
    if (!href) return base;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
    try {
      return new URL(href, base).href;
    } catch {
      return base;
    }
  }

  private slugFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const slug = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-');
      return slug || 'job';
    } catch {
      return 'job';
    }
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    let out = value.split(String.fromCharCode(160)).join(' ');
    out = this.collapseWhitespace(out);
    return out.trim();
  }

  private collapseWhitespace(value: string): string {
    const result: string[] = [];
    let spacePending = false;
    for (const ch of value) {
      if (this.isWhitespace(ch)) {
        spacePending = true;
      } else {
        if (spacePending) {
          result.push(' ');
          spacePending = false;
        }
        result.push(ch);
      }
    }
    return result.join('');
  }

  private isWhitespace(ch: string): boolean {
    return (
      ch === ' ' ||
      ch === String.fromCharCode(9) ||
      ch === String.fromCharCode(10) ||
      ch === String.fromCharCode(13) ||
      ch === String.fromCharCode(11) ||
      ch === String.fromCharCode(12)
    );
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  private errorLabel(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return 'unknown error';
    }
    const status = (error as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number') {
      return `HTTP ${status}`;
    }
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
