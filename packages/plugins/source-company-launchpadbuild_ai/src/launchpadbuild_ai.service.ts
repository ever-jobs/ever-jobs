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
  jobTypeScanOptions,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, markdownConverter } from '@ever-jobs/common';
import {
  LAUNCHPADBUILD_AI_CAREERS_URL,
  LAUNCHPADBUILD_AI_COMPANY_NAME,
  LAUNCHPADBUILD_AI_DEFAULT_RESULTS,
  LAUNCHPADBUILD_AI_DEFAULT_TIMEOUT_SECONDS,
  LAUNCHPADBUILD_AI_ORIGIN,
} from './launchpadbuild_ai.constants';

interface JobRef {
  title: string;
  jobUrl: string;
  employmentTerm: string | null;
  locationTerm: string | null;
}

interface DetailSpecs {
  employmentType: string | null;
  location: string | null;
  schedule: string | null;
}

interface SectionData {
  html: string;
  text: string;
}

interface ParsedSections {
  order: string[];
  map: Map<string, SectionData>;
}

@SourcePlugin({
  site: Site.LAUNCHPADBUILD_AI,
  name: 'Launchpad Build AI',
  category: 'company',
  companyDomains: ['launchpadbuild.ai'],
})
@Injectable()
export class LaunchpadbuildAiService implements IScraper {
  private readonly logger = new Logger(LaunchpadbuildAiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      this.logger.log(`Launchpad Build AI: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Launchpad Build AI scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? LAUNCHPADBUILD_AI_DEFAULT_TIMEOUT_SECONDS,
    });

    const companyUrl = input.companyUrl || LAUNCHPADBUILD_AI_CAREERS_URL;
    const startRes = await client.get<string>(companyUrl);
    const $ = cheerio.load(startRes.data);
    const refs = this.parseCareersList($, companyUrl);
    if (refs.length === 0) {
      throw new Error('Launchpad Build AI careers page is missing the awsm-job-listings container');
    }

    const jobs: JobPostDto[] = [];
    for (const ref of refs) {
      const job = await this.fetchDetail(client, ref, companyUrl);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private parseCareersList($: cheerio.CheerioAPI, companyUrl: string): JobRef[] {
    const refs: JobRef[] = [];
    $('div.awsm-job-listings.awsm-lists > div.awsm-job-listing-item').each((_, el) => {
      const $item = $(el);
      const $a = $item.find('h2.awsm-job-post-title a').first();
      const href = $a.attr('href')?.trim();
      const title = this.normalize($a.text());
      if (!href || !title) return;

      refs.push({
        title,
        jobUrl: this.resolveUrl(href, companyUrl),
        employmentTerm: this.normalize(
          $item.find('.awsm-job-specification-job-type .awsm-job-specification-term').text(),
        ),
        locationTerm: this.normalize(
          $item.find('.awsm-job-specification-job-location .awsm-job-specification-term').text(),
        ),
      });
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

    const applyUrl = ref.jobUrl;
    const specs = this.parseSpecifications($);
    const sections = this.extractSections($);
    const location = this.parseLocation(ref, specs, sections);
    const workFromHomeType = this.parseWorkFromHomeType(ref, specs, sections);
    const isRemote = this.parseIsRemote(specs, sections);
    const compensation = this.parseCompensation(sections);
    const description = this.buildDescription(sections);
    const { jobTypes, employmentType } = this.parseJobTypes(ref, specs, sections);

    const slug = this.slugFromUrl(ref.jobUrl);
    return new JobPostDto({
      id: `launchpadbuild_ai-${slug}`,
      site: Site.LAUNCHPADBUILD_AI,
      title,
      companyName: LAUNCHPADBUILD_AI_COMPANY_NAME,
      companyUrl,
      jobUrl: ref.jobUrl,
      jobUrlDirect: ref.jobUrl,
      applyUrl,
      location,
      description,
      compensation,
      isRemote,
      workFromHomeType,
      jobType: jobTypes,
      employmentType,
    });
  }

  private extractTitle($: cheerio.CheerioAPI): string | null {
    const text = this.normalize($('h1.elementor-heading-title').first().text());
    return text || null;
  }

  private parseSpecifications($: cheerio.CheerioAPI): DetailSpecs {
    return {
      employmentType: this.normalize(
        $('.awsm-job-specification-job-type .awsm-job-specification-term').first().text(),
      ),
      location: this.normalize(
        $('.awsm-job-specification-job-location .awsm-job-specification-term').first().text(),
      ),
      schedule: this.normalize(
        $('.awsm-job-specification-job-schedule .awsm-job-specification-term').first().text(),
      ),
    };
  }

  private extractSections($: cheerio.CheerioAPI): ParsedSections {
    const order: string[] = [];
    const map = new Map<string, SectionData>();
    const buffers = new Map<string, { htmls: string[]; texts: string[] }>();
    let currentHeading: string | null = null;

    $('div.awsm-job-entry-content.entry-content')
      .first()
      .children()
      .each((_, el) => {
        const $el = $(el);
        const tagName = el.tagName?.toLowerCase();
        if (tagName === 'h3' || $el.hasClass('wp-block-heading')) {
          const heading = this.normalize($el.text()).replace(/[:：]+$/g, '');
          if (heading) {
            currentHeading = heading;
            if (!order.includes(heading)) {
              order.push(heading);
              buffers.set(heading, { htmls: [], texts: [] });
            }
          }
        } else {
          const text = this.normalize($el.text());
          if (!text) return;
          const html = $el.html() ?? '';
          if (!currentHeading) {
            currentHeading = 'Overview';
            if (!order.includes(currentHeading)) {
              order.push(currentHeading);
              buffers.set(currentHeading, { htmls: [], texts: [] });
            }
          }
          const buffer = buffers.get(currentHeading);
          if (buffer) {
            buffer.htmls.push(html);
            buffer.texts.push(text);
          }
        }
      });

    for (const heading of order) {
      const buffer = buffers.get(heading);
      if (buffer && (buffer.htmls.length || buffer.texts.length)) {
        map.set(heading, {
          html: buffer.htmls.join(String.fromCharCode(10)),
          text: buffer.texts.join(' '),
        });
      }
    }

    return { order, map };
  }

  private buildDescription(sections: ParsedSections): string | null {
    const lines: string[] = [];
    for (const heading of sections.order) {
      const data = sections.map.get(heading);
      if (!data?.html) continue;
      const markdown = markdownConverter(data.html);
      if (!markdown) continue;
      lines.push(`## ${heading}`, '', markdown, '');
    }
    return lines.join(String.fromCharCode(10)).trim() || null;
  }

  private parseLocation(
    ref: JobRef,
    specs: DetailSpecs,
    sections: ParsedSections,
  ): LocationDto | null {
    const raw = specs.location || ref.locationTerm;
    if (raw) {
      return this.parseLocationString(raw);
    }

    const whyLaunchpad = this.findSectionText(sections, 'why launchpad');
    if (whyLaunchpad && /\bUK\s+based\b/i.test(whyLaunchpad)) {
      return new LocationDto({
        country: Country.UK,
      });
    }

    return null;
  }

  private parseLocationString(raw: string): LocationDto | null {
    const text = this.normalize(raw);
    if (!text) return null;

    const match = text.match(/^(.*?)\s+([A-Za-z]{2})$/);
    if (match && match[1]) {
      const city = match[1].trim();
      const state = match[2].toUpperCase();
      if (/^[A-Z]{2}$/.test(state)) {
        return new LocationDto({
          city,
          state,
          country: Country.USA,
        });
      }
    }

    return new LocationDto({
      city: text,
      country: Country.USA,
    });
  }

  private parseWorkFromHomeType(
    ref: JobRef,
    specs: DetailSpecs,
    sections: ParsedSections,
  ): string | null {
    const schedule = specs.schedule;
    if (schedule) {
      const lower = schedule.toLowerCase();
      if (lower.includes('on-site') || lower.includes('onsite')) return 'On Site';
      if (lower.includes('hybrid')) return 'Hybrid';
      if (lower.includes('remote')) return 'Remote';
    }

    const whyLaunchpad = this.findSectionText(sections, 'why launchpad');
    if (whyLaunchpad && /\bhybrid\s+option(s?)\b/i.test(whyLaunchpad)) {
      return 'Hybrid';
    }

    if (ref.locationTerm && ref.locationTerm.toLowerCase().includes('remote')) {
      return 'Remote';
    }

    return 'On Site';
  }

  private parseIsRemote(specs: DetailSpecs, sections: ParsedSections): boolean {
    if (specs.schedule && /\bremote\b/i.test(specs.schedule)) {
      return true;
    }
    const text = this.allSectionText(sections);
    return /\bremote\b/i.test(text);
  }

  private parseCompensation(sections: ParsedSections): CompensationDto | null {
    const raw = this.findSectionText(sections, 'compensation');
    if (!raw) return null;

    const text = this.normalize(raw);
    const segments = text.split(/\s*,\s*\s*or\s+|\s+or\s+/i);
    const chosen =
      segments.find((s) => /year|annual|salaried/.test(s.toLowerCase())) || segments[0];
    if (!chosen) return null;

    const rangeMatch = chosen.match(
      /\$\s*([\d,]+(?:\.\d+)?)\s*(?:[–—-]|to)\s*\$\s*([\d,]+(?:\.\d+)?)/,
    );
    if (!rangeMatch) return null;

    const minAmount = this.parseAmount(rangeMatch[1]);
    const maxAmount = this.parseAmount(rangeMatch[2]);
    if (minAmount === null || maxAmount === null) return null;

    const lower = chosen.toLowerCase();
    let interval: CompensationInterval;
    if (/\b(per\s+year|yearly|annual|salaried)\b/.test(lower)) {
      interval = CompensationInterval.YEARLY;
    } else if (/\b(per\s+hour|hourly)\b/.test(lower)) {
      interval = CompensationInterval.HOURLY;
    } else if (/\b(per\s+month|monthly)\b/.test(lower)) {
      interval = CompensationInterval.MONTHLY;
    } else if (/\b(per\s+week|weekly)\b/.test(lower)) {
      interval = CompensationInterval.WEEKLY;
    } else if (/\b(per\s+day|daily)\b/.test(lower)) {
      interval = CompensationInterval.DAILY;
    } else {
      interval = CompensationInterval.YEARLY;
    }

    return new CompensationDto({
      interval,
      minAmount,
      maxAmount,
      currency: 'USD',
    });
  }

  private parseAmount(value: string): number | null {
    const cleaned = value
      .split('')
      .filter((ch) => (ch >= '0' && ch <= '9') || ch === '.')
      .join('');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  private parseJobTypes(
    ref: JobRef,
    specs: DetailSpecs,
    sections: ParsedSections,
  ): { jobTypes: JobType[]; employmentType: string | null } {
    const rawEmployment = specs.employmentType || ref.employmentTerm;
    if (rawEmployment) {
      const type = getJobTypeFromString(rawEmployment);
      if (type) {
        return { jobTypes: [type], employmentType: this.jobTypeLabel(type) };
      }
    }

    const result = this.parseJobTypesFromDescription(sections);
    if (result.jobTypes.length > 0) {
      return result;
    }

    return { jobTypes: [JobType.FULL_TIME], employmentType: 'Full time' };
  }

  private parseJobTypesFromDescription(sections: ParsedSections): {
    jobTypes: JobType[];
    employmentType: string | null;
  } {
    const parts: string[] = [];
    for (const heading of sections.order) {
      const lower = heading.toLowerCase();
      if (
        lower.includes('type') ||
        lower.includes('employment') ||
        lower.includes('contract') ||
        lower.includes('details') ||
        lower.includes('position') ||
        lower.includes('compensation') ||
        lower.includes('benefits') ||
        lower.includes('summary')
      ) {
        const data = sections.map.get(heading);
        if (data?.text) parts.push(data.text);
      }
    }

    const text = this.normalize(parts.join(' ')).toLowerCase();
    const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
    const jobTypes: JobType[] = [];
    const labels: string[] = [];
    // Words scanned out of prose (summary / benefits included): prose-ambiguous aliases
    // ("permanent residency", "and other perks") are ignored unless
    // EVER_JOBS_JOB_TYPE_SCAN_MODE=label.
    const scanOptions = jobTypeScanOptions(process.env);

    for (let i = 0; i < tokens.length; i++) {
      const unigram = tokens[i];
      const fromUni = getJobTypeFromString(unigram, scanOptions);
      this.addJobType(jobTypes, labels, fromUni);

      if (unigram === 'intern') {
        this.addJobType(jobTypes, labels, JobType.INTERNSHIP);
      }

      if (i + 1 < tokens.length) {
        const bigram = `${tokens[i]} ${tokens[i + 1]}`;
        const fromBi = getJobTypeFromString(bigram, scanOptions);
        this.addJobType(jobTypes, labels, fromBi);
      }
    }

    return { jobTypes, employmentType: labels.join(', ') || null };
  }

  private addJobType(
    jobTypes: JobType[],
    labels: string[],
    type: JobType | null,
  ): void {
    if (!type || jobTypes.includes(type)) return;
    jobTypes.push(type);
    labels.push(this.jobTypeLabel(type));
  }

  private jobTypeLabel(type: JobType): string {
    const labels: Record<JobType, string> = {
      [JobType.FULL_TIME]: 'Full time',
      [JobType.PART_TIME]: 'Part time',
      [JobType.CONTRACT]: 'Contract',
      [JobType.TEMPORARY]: 'Temporary',
      [JobType.INTERNSHIP]: 'Internship',
      [JobType.PER_DIEM]: 'Per diem',
      [JobType.NIGHTS]: 'Nights',
      [JobType.OTHER]: 'Other',
      [JobType.SUMMER]: 'Summer',
      [JobType.VOLUNTEER]: 'Volunteer',
      [JobType.PERMANENT]: 'Permanent',
      [JobType.APPRENTICESHIP]: 'Apprenticeship',
    };
    return labels[type] ?? 'Other';
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
    const requested = this.nonNegativeInt(input.resultsWanted, LAUNCHPADBUILD_AI_DEFAULT_RESULTS);
    return filtered.slice(offset, offset + requested);
  }

  private findSectionText(sections: ParsedSections, prefix: string): string | null {
    const target = prefix.toLowerCase();
    for (const [heading, data] of sections.map) {
      if (heading.toLowerCase().startsWith(target)) {
        return data.text || null;
      }
    }
    return null;
  }

  private allSectionText(sections: ParsedSections): string {
    return this.normalize(
      sections.order.map((heading) => sections.map.get(heading)?.text).join(' '),
    );
  }

  private resolveUrl(href: string, base: string): string {
    if (!href) return base;
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
    const origin = base.replace(/\/$/, '');
    if (href.startsWith('/')) return `${origin}${href}`;
    return `${origin}/${href}`;
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
