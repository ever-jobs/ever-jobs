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
  ATLASSPACE_CAREERS_URL,
  ATLASSPACE_COMPANY_NAME,
  ATLASSPACE_DEFAULT_RESULTS,
  ATLASSPACE_DEFAULT_TIMEOUT_SECONDS,
  ATLASSPACE_ORIGIN,
} from './atlasspace.constants';

interface JobRef {
  title: string;
  jobUrl: string;
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
  site: Site.ATLAS,
  name: 'ATLAS Space Operations',
  category: 'company',
  companyDomains: ['atlasspace.com'],
})
@Injectable()
export class AtlasspaceService implements IScraper {
  private readonly logger = new Logger(AtlasspaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      this.logger.log(`ATLAS Space Operations: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `ATLAS Space Operations scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? ATLASSPACE_DEFAULT_TIMEOUT_SECONDS,
    });

    const companyUrl = input.companyUrl || ATLASSPACE_CAREERS_URL;
    const startRes = await client.get<string>(companyUrl);
    const $ = cheerio.load(startRes.data);
    const refs = this.parseCareersList($, companyUrl);
    if (refs.length === 0) {
      throw new Error('ATLAS careers page is missing the Current Openings list');
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
    const heading = $('h2.elementor-heading-title')
      .filter((_, el) => this.normalize($(el).text()).includes('Current Openings'))
      .first();
    if (!heading.length) return refs;

    const list = heading
      .closest('.elementor-widget-heading')
      .nextAll('.elementor-widget-icon-list')
      .find('ul.elementor-icon-list-items')
      .first();

    list.find('li.elementor-icon-list-item').each((_, li) => {
      const $li = $(li);
      const $a = $li.find('a').first();
      const href = $a.attr('href')?.trim();
      const title = this.normalize($a.find('.elementor-icon-list-text').first().text());
      if (href && title) {
        refs.push({
          title,
          jobUrl: this.resolveUrl(href, companyUrl),
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

    const applyUrl = this.extractApplyUrl($);
    const sections = this.extractSections($);
    const location = this.parseLocation(sections);
    const compensation = this.parseCompensation(sections);
    const description = this.buildDescription(sections);
    const { jobTypes, employmentType } = this.parseJobTypes(sections);

    const slug = this.slugFromUrl(ref.jobUrl);
    return new JobPostDto({
      id: `atlasspace-${slug}`,
      site: Site.ATLAS,
      title,
      companyName: ATLASSPACE_COMPANY_NAME,
      companyUrl,
      jobUrl: ref.jobUrl,
      jobUrlDirect: ref.jobUrl,
      applyUrl,
      location,
      description,
      compensation,
      isRemote: false,
      workFromHomeType: 'On Site',
      jobType: jobTypes,
      employmentType,
    });
  }

  private extractTitle($: cheerio.CheerioAPI): string | null {
    const text = this.normalize($('h2.elementor-heading-title').first().text());
    return text || null;
  }

  private extractApplyUrl($: cheerio.CheerioAPI): string | null {
    const link = $('a.elementor-button.elementor-button-link')
      .filter((_, el) => {
        const text = this.normalize($(el).text());
        return text.includes('Apply for this Job');
      })
      .first();
    const href = link.attr('href')?.trim();
    return href ? this.resolveUrl(href, ATLASSPACE_ORIGIN) : null;
  }

  private extractSections($: cheerio.CheerioAPI): ParsedSections {
    const order: string[] = [];
    const map = new Map<string, SectionData>();
    const buffers = new Map<string, { htmls: string[]; texts: string[] }>();
    let currentHeading: string | null = null;

    $('.elementor-widget-heading, .elementor-widget-text-editor').each((_, el) => {
      const $el = $(el);
      if ($el.hasClass('elementor-widget-heading')) {
        const headingText = this.normalize($el.find('h4.elementor-heading-title').first().text()).replace(/[:：]+$/g, '');
        if (headingText) {
          currentHeading = headingText;
          if (!order.includes(headingText)) {
            order.push(headingText);
            buffers.set(headingText, { htmls: [], texts: [] });
          }
        }
      } else if ($el.hasClass('elementor-widget-text-editor')) {
        const html = $el.find('.elementor-widget-container').html() ?? $el.html() ?? '';
        const text = $el.find('.elementor-widget-container').text() ?? $el.text() ?? '';
        if (this.normalize(html) && this.normalize(text)) {
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

  private parseLocation(sections: ParsedSections): LocationDto | null {
    const raw = this.findSectionText(sections, 'location');
    if (!raw) return null;

    let text = this.normalize(raw);
    if (text.toLowerCase().startsWith('preference:')) {
      text = text.slice('preference:'.length).trim();
    }
    const firstOption = text.split(' or ')[0].trim();
    const commaIdx = firstOption.lastIndexOf(',');
    if (commaIdx > 0) {
      const city = firstOption.slice(0, commaIdx).trim();
      const state = firstOption.slice(commaIdx + 1).trim();
      if (/^[A-Za-z]{2}$/.test(state)) {
        return new LocationDto({
          city,
          state: state.toUpperCase(),
          country: Country.USA,
        });
      }
    }
    return new LocationDto({
      city: firstOption,
      country: Country.USA,
    });
  }

  private parseCompensation(sections: ParsedSections): CompensationDto | null {
    const raw = this.findSectionText(sections, 'salary');
    if (!raw) return null;

    const text = this.normalize(raw);
    const values: number[] = [];
    const spaced = text
      .split(String.fromCharCode(8211))
      .join(' ')
      .split(String.fromCharCode(8212))
      .join(' ')
      .split('-')
      .join(' ')
      .split(' ')
      .filter(Boolean);
    for (const token of spaced) {
      if (token.includes('$')) {
        const amount = this.parseAmount(token);
        if (amount !== null) values.push(amount);
      }
    }
    if (values.length === 0) return null;

    const minAmount = Math.min(...values);
    const maxAmount = Math.max(...values);
    const interval = this.inferCompensationInterval(text);
    return new CompensationDto({
      interval,
      minAmount,
      maxAmount,
      currency: 'USD',
    });
  }

  private inferCompensationInterval(text: string): CompensationInterval {
    const lower = text.toLowerCase();
    if (lower.includes('hour') || lower.includes('hr')) return CompensationInterval.HOURLY;
    if (lower.includes('month')) return CompensationInterval.MONTHLY;
    if (lower.includes('week')) return CompensationInterval.WEEKLY;
    if (lower.includes('day')) return CompensationInterval.DAILY;
    return CompensationInterval.YEARLY;
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

  private findSectionText(sections: ParsedSections, prefix: string): string | null {
    const target = prefix.toLowerCase();
    for (const [heading, data] of sections.map) {
      if (heading.toLowerCase().startsWith(target)) {
        return data.text || null;
      }
    }
    return null;
  }

  private parseJobTypes(sections: ParsedSections): {
    jobTypes: JobType[];
    employmentType: string | null;
  } {
    const parts: string[] = [];
    for (const heading of sections.order) {
      const lowerHeading = heading.toLowerCase();
      if (
        lowerHeading.includes('type') ||
        lowerHeading.includes('employment') ||
        lowerHeading.includes('contract') ||
        lowerHeading.includes('details') ||
        lowerHeading.includes('position')
      ) {
        const data = sections.map.get(heading);
        if (data?.text) parts.push(data.text);
      }
    }
    const text = this.normalize(parts.join(' ')).toLowerCase();
    const fullText = this.normalize(
      sections.order.map((heading) => sections.map.get(heading)?.text).join(' '),
    ).toLowerCase();
    const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
    const jobTypes: JobType[] = [];
    const labels: string[] = [];
    // Words scanned out of prose: prose-ambiguous aliases ("permanent residency",
    // "and other duties") are ignored unless EVER_JOBS_JOB_TYPE_SCAN_MODE=label.
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

    if (
      jobTypes.length === 0 &&
      (this.findSectionText(sections, 'salary') ||
        fullText.includes('salary') ||
        fullText.includes('annual'))
    ) {
      this.addJobType(jobTypes, labels, JobType.FULL_TIME);
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
    const requested = this.nonNegativeInt(input.resultsWanted, ATLASSPACE_DEFAULT_RESULTS);
    return filtered.slice(offset, offset + requested);
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
