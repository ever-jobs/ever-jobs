import { Injectable, Logger } from '@nestjs/common';
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
  createHttpClient,
  extractEmails,
  markdownConverter,
  parseLocationList,
  salaryToCompensation,
} from '@ever-jobs/common';
import {
  NANONUCLEARENERGY_CAREERS_SLUG,
  NANONUCLEARENERGY_CAREERS_URL,
  NANONUCLEARENERGY_COMPANY_NAME,
  NANONUCLEARENERGY_DEFAULT_RESULTS,
  NANONUCLEARENERGY_DEFAULT_TIMEOUT_SECONDS,
  nanonuclearenergyPagesUrl,
} from './nanonuclearenergy.constants';
import { NanoRole, WpPage } from './nanonuclearenergy.types';

/** Accumulator for a role while walking the Divi modules in document order. */
interface RoleDraft {
  title: string;
  subtitleHtml: string | null;
  bodyHtml: string;
  employmentType: string | null;
  location: string | null;
  salaryText: string | null;
  metaStarted: boolean;
}

@SourcePlugin({
  site: Site.NANONUCLEARENERGY,
  name: 'NANO Nuclear Energy',
  category: 'company',
})
@Injectable()
export class NanonuclearenergyService implements IScraper {
  private readonly logger = new Logger(NanonuclearenergyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? NANONUCLEARENERGY_DEFAULT_TIMEOUT_SECONDS,
      });

      const response = await client.get<WpPage[]>(
        nanonuclearenergyPagesUrl(NANONUCLEARENERGY_CAREERS_SLUG),
      );
      const pages = Array.isArray(response.data) ? response.data : [];
      const html = pages[0]?.content?.rendered ?? '';
      if (!html) {
        this.logger.warn('NANO Nuclear careers page returned no content');
        return new JobResponseDto([]);
      }

      const roles = this.parseRoles(html);
      if (roles.length === 0) {
        this.logger.warn('NANO Nuclear careers page contained no roles');
        return new JobResponseDto([]);
      }

      const jobs = this.applyInput(
        roles.map((role) => this.toJobPost(role)),
        input,
      );

      this.logger.log(`NANO Nuclear Energy: scraped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(
        `NANO Nuclear Energy scrape failed (${this.errorLabel(error)})`,
      );
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse the Divi careers markup. Each role is a run of sibling modules — a
   * title "blurb" (an `h4` heading + optional subtitle), a text module with the
   * body, then meta blurbs (`Full Time`, `Location - …`, `Salary: …`). Walk the
   * blurb/text modules in document order: a blurb carrying an `h4` opens a new
   * role, the following text module is its body, and the label-prefixed blurbs
   * fill its meta.
   */
  private parseRoles(html: string): NanoRole[] {
    const $ = cheerio.load(html);
    const drafts: RoleDraft[] = [];
    let current: RoleDraft | null = null;

    $('.et_pb_blurb, .et_pb_text').each((_index, element) => {
      const $el = $(element);
      if ($el.hasClass('et_pb_blurb')) {
        const title = this.normalize(
          $el.find('h4.et_pb_module_header').first().text(),
        );
        const $desc = $el.find('.et_pb_blurb_description').first();
        if (title) {
          current = {
            title,
            subtitleHtml: $desc.html(),
            bodyHtml: '',
            employmentType: null,
            location: null,
            salaryText: null,
            metaStarted: false,
          };
          drafts.push(current);
          return;
        }
        if (current) this.assignMeta(current, this.normalize($desc.text()));
        return;
      }

      // Text module: the role body precedes the meta blurbs.
      if (current && !current.metaStarted) {
        current.bodyHtml += $el.find('.et_pb_text_inner').first().html() ?? '';
      }
    });

    return drafts.map((draft) => this.finalizeRole(draft));
  }

  /** Route a meta blurb's text to the matching field by its label prefix. */
  private assignMeta(draft: RoleDraft, text: string): void {
    if (!text) return;
    if (/^full[\s-]?time|^part[\s-]?time|^contract|^intern/i.test(text)) {
      draft.employmentType = text;
      draft.metaStarted = true;
      return;
    }
    if (/^location\b/i.test(text)) {
      draft.location = text
        .replace(/^location\b/i, '')
        .replace(/^[\s:–—-]+/, '')
        .trim();
      draft.metaStarted = true;
      return;
    }
    if (/^salary\b/i.test(text) || /\$?\s?\d[\d,]/.test(text)) {
      draft.salaryText = text;
      draft.metaStarted = true;
    }
  }

  private finalizeRole(draft: RoleDraft): NanoRole {
    const subtitleText = this.normalize(
      draft.subtitleHtml ? cheerio.load(draft.subtitleHtml).text() : '',
    );
    const bodyMarkdown = markdownConverter(draft.bodyHtml) ?? '';
    const parts: string[] = [];
    if (subtitleText) parts.push(`**${subtitleText}**`);
    if (bodyMarkdown) parts.push(bodyMarkdown);
    const body = this.collapse(parts.join('\n\n'));

    return {
      title: draft.title,
      subtitle: subtitleText || null,
      body: body || null,
      employmentType: draft.employmentType,
      location: draft.location,
      salaryText: draft.salaryText,
    };
  }

  private toJobPost(role: NanoRole): JobPostDto {
    const parsed = parseLocationList([role.location ?? null]);
    const location: LocationDto | null = role.location
      ? parsed.location
      : null;

    const salaryText = this.salaryText(role.salaryText);
    // Every role states an annual base ("estimated base salary range … per
    // year"), so the interval is authoritative — pass it rather than let the
    // shared parser guess from magnitude.
    const compensation: CompensationDto | null = salaryText
      ? salaryToCompensation(salaryText, {
          interval: CompensationInterval.YEARLY,
        })
      : null;

    const employmentType = role.employmentType || null;
    const jobType = employmentType ? getJobTypeFromString(employmentType) : null;

    return new JobPostDto({
      id: `nanonuclearenergy-${this.slug(role)}`,
      site: Site.NANONUCLEARENERGY,
      title: role.title,
      companyName: NANONUCLEARENERGY_COMPANY_NAME,
      companyUrl: NANONUCLEARENERGY_CAREERS_URL,
      jobUrl: NANONUCLEARENERGY_CAREERS_URL,
      location,
      description: role.body,
      isRemote: role.location ? parsed.remoteMentioned : null,
      ...(parsed.workFromHomeType
        ? { workFromHomeType: parsed.workFromHomeType }
        : {}),
      ...(employmentType ? { employmentType } : {}),
      ...(jobType ? { jobType: [jobType] } : {}),
      ...(compensation ? { compensation } : {}),
      datePosted: null,
      emails: extractEmails(role.body),
    });
  }

  /**
   * Normalise the pay prose into a `"$min - $max"` string the shared parser can
   * read. The source is authored in Word, so the numbers carry paste artifacts:
   * a space after `$` (`$ 130,000`), spaces inside a group (`$1 48 ,000`), or a
   * missing `$` on one end (`99,000 - $131,000`). Strip the label, normalise
   * unicode dashes, close the intra-number gaps, then rebuild from the first two
   * numeric groups so a `$` is present on both ends.
   */
  private salaryText(raw: string | null): string | null {
    if (!raw) return null;
    let text = raw
      .replace(/^\s*salary\s*:?/i, '')
      .replace(/[\u2012-\u2015\u2212]/g, '-')
      .replace(/\$\s+/g, '$');
    let previous = '';
    while (previous !== text) {
      previous = text;
      text = text.replace(/([\d,])\s+([\d,])/g, '$1$2');
    }
    const numbers = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
    if (numbers.length === 0) return null;
    if (numbers.length === 1) return `$${numbers[0]}`;
    return `$${numbers[0]} - $${numbers[1]}`;
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
      NANONUCLEARENERGY_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  /**
   * Stable id slug. Titles repeat (two "Nuclear Engineer" roles), so fold in
   * the subtitle when present to keep ids distinct.
   */
  private slug(role: NanoRole): string {
    const base = role.subtitle ? `${role.title} ${role.subtitle}` : role.title;
    return base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
