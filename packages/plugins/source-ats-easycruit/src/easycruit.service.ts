import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  EASYCRUIT_HOST_TEMPLATE,
  EASYCRUIT_FEED_PATH,
  EASYCRUIT_VACANCY_PATH,
  EASYCRUIT_DEFAULT_ISO,
  EASYCRUIT_DEFAULT_RESULTS,
  EASYCRUIT_HEADERS,
  EASYCRUIT_VACANCY_REGEX,
  EASYCRUIT_VERSION_REGEX,
  EASYCRUIT_DEPARTMENT_REGEX,
} from './easycruit.constants';
import {
  EasyCruitVacancy,
  EasyCruitVacancyVersion,
  EasyCruitDepartment,
} from './easycruit.types';

/**
 * EasyCruit ATS careers scraper — generic, multi-tenant.
 *
 * EasyCruit (easycruit.com, Visma) serves every customer's open roles through
 * one public, unauthenticated XML vacancy feed on the tenant's own sub-domain
 * (`GET https://{tenant}.easycruit.com/export/xml/vacancy/list.xml`). The feed
 * returns the full open-roles list in one `VacancyList` envelope — there is no
 * server-side pagination, so we fetch once and slice client-side to honour
 * `resultsWanted`.
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `esvagt`) or by `companyUrl`. Each `<Vacancy>` carries one or more language
 * `<Version>` blocks; the English version is preferred when present. A single
 * fetch error, an unknown tenant (HTTP 4xx), or a malformed payload degrades
 * to an empty result rather than throwing, so a single tenant never nukes a
 * batch run.
 */
@SourcePlugin({
  site: Site.EASYCRUIT,
  name: 'EasyCruit',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class EasyCruitService implements IScraper {
  private readonly logger = new Logger(EasyCruitService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for EasyCruit scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an EasyCruit tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(EASYCRUIT_HEADERS);

    const resultsWanted = input.resultsWanted ?? EASYCRUIT_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching EasyCruit jobs for tenant: ${tenant}`);

      // The feed returns every open role for the tenant in a single envelope.
      const xml = await this.fetchFeed(client, tenant);
      const vacancies = xml ? this.parseVacancyList(xml) : [];

      this.collect(vacancies, tenant, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`EasyCruit total: ${trimmed.length} jobs for ${tenant}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`EasyCruit scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch the tenant's vacancy-list XML from the public feed. */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<string | null> {
    const host = EASYCRUIT_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const url = `${host}${EASYCRUIT_FEED_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const data = response.data;
      if (typeof data !== 'string' || !data.includes('<Vacancy')) {
        this.logger.warn(`EasyCruit feed for "${tenant}" returned no vacancies`);
        return null;
      }
      return data;
    } catch (err: any) {
      // An unknown tenant / dead feed returns HTTP 404 (or other 4xx); treat
      // that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`EasyCruit tenant "${tenant}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse the `VacancyList` XML into structured vacancy objects. Hand-rolled,
   * tolerant regex parsing (no XML-parser dependency) — the feed is a flat,
   * predictable structure and any unparseable block is skipped, never thrown.
   */
  private parseVacancyList(xml: string): EasyCruitVacancy[] {
    const out: EasyCruitVacancy[] = [];
    const vacancyRe = new RegExp(EASYCRUIT_VACANCY_REGEX.source, EASYCRUIT_VACANCY_REGEX.flags);
    let m: RegExpExecArray | null;
    while ((m = vacancyRe.exec(xml)) !== null) {
      try {
        const attrs = m[1] ?? '';
        const body = m[2] ?? '';
        out.push({
          id: this.attr(attrs, 'id'),
          date_start: this.attr(attrs, 'date_start'),
          date_end: this.attr(attrs, 'date_end'),
          date_modified: this.attr(attrs, 'date_modified'),
          reference_number: this.attr(attrs, 'reference_number'),
          versions: this.parseVersions(body),
          departments: this.parseDepartments(body),
        });
      } catch (err: any) {
        this.logger.warn(`Error parsing an EasyCruit vacancy block: ${err.message}`);
      }
    }
    return out;
  }

  private parseVersions(body: string): EasyCruitVacancyVersion[] {
    const out: EasyCruitVacancyVersion[] = [];
    const re = new RegExp(EASYCRUIT_VERSION_REGEX.source, EASYCRUIT_VERSION_REGEX.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const language = m[1] ?? null;
      const vBody = m[2] ?? '';
      out.push({
        language,
        title: this.tag(vBody, 'Title'),
        titleHeading: this.tag(vBody, 'TitleHeading'),
        location: this.tag(vBody, 'Location'),
        region: this.tag(vBody, 'Region'),
        engagement: this.tag(vBody, 'Engagement'),
        dailyHours: this.tag(vBody, 'DailyHours'),
        categories: this.tag(vBody, 'Categories'),
        applicationDeadline: this.tag(vBody, 'ApplicationDeadline'),
      });
    }
    return out;
  }

  private parseDepartments(body: string): EasyCruitDepartment[] {
    const out: EasyCruitDepartment[] = [];
    const re = new RegExp(EASYCRUIT_DEPARTMENT_REGEX.source, EASYCRUIT_DEPARTMENT_REGEX.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const id = m[1] ?? null;
      const dBody = m[2] ?? '';
      out.push({
        id,
        name: this.tag(dBody, 'Name'),
        vacancyUrl: this.tag(dBody, 'VacancyURL'),
        applicationUrl: this.tag(dBody, 'ApplicationURL'),
        logoUrl: this.tag(dBody, 'LogoURL'),
        imageUrl: this.tag(dBody, 'ImageURL'),
      });
    }
    return out;
  }

  /** Extract a single XML attribute value from an element's attribute string. */
  private attr(attrs: string, name: string): string | null {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
    const v = m && typeof m[1] === 'string' ? m[1].trim() : '';
    return v ? this.decodeEntities(v) : null;
  }

  /**
   * Extract a single child element's text content, transparently unwrapping a
   * `<![CDATA[…]]>` wrapper and decoding XML entities. Returns null when the
   * element is absent or empty.
   */
  private tag(body: string, name: string): string | null {
    const m = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (!m || typeof m[1] !== 'string') return null;
    let raw = m[1].trim();
    const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) raw = cdata[1];
    raw = raw.trim();
    if (!raw) return null;
    return this.decodeEntities(raw);
  }

  /** Decode the handful of XML entities the feed uses. */
  private decodeEntities(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** Map raw vacancies → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    vacancies: EasyCruitVacancy[],
    tenant: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const vacancy of vacancies) {
      try {
        const post = this.processVacancy(vacancy, tenant, format);
        if (!post) continue;
        // processVacancy guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing EasyCruit vacancy ${vacancy?.id}: ${err.message}`);
      }
    }
  }

  private processVacancy(
    vacancy: EasyCruitVacancy,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const atsId = String(vacancy.id ?? '').trim();
    if (!atsId) return null;

    const version = this.pickVersion(vacancy);
    const department = this.pickDepartment(vacancy);

    const title = this.value(version?.title, version?.Title);
    if (!title) return null;

    const jobUrl = this.buildJobUrl(vacancy, department, tenant, atsId);
    if (!jobUrl) return null;

    const applyUrl =
      this.value(department?.applicationUrl, department?.ApplicationURL) ?? jobUrl;

    // EasyCruit version blocks carry no rich job-body element in the public
    // list feed; we synthesise a short HTML summary from the available labels
    // so description formatting / e-mail extraction stay consistent.
    const rawHtml = this.buildDescriptionHtml(version);
    const description = this.formatDescription(rawHtml, format);

    const companyName = this.deriveCompanyName(
      this.value(department?.name, department?.Name),
      tenant,
    );

    return new JobPostDto({
      id: `easycruit-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(version),
      description,
      datePosted: this.parseDate(
        this.value(vacancy.date_start, vacancy.dateStart) ??
          this.value(vacancy.date_modified, vacancy.dateModified),
      ),
      isRemote: this.detectRemote(version, title),
      emails: extractEmails(description),
      site: Site.EASYCRUIT,
      atsId,
      atsType: 'easycruit',
      department: this.extractDepartment(version, department),
      employmentType: this.value(version?.engagement, version?.Engagement),
      applyUrl,
    });
  }

  /**
   * Pick the most useful language `<Version>`: prefer an English rendering
   * (`en`/`gb`/`eng`), else the first version that carries a title, else the
   * first version present.
   */
  private pickVersion(vacancy: EasyCruitVacancy): EasyCruitVacancyVersion | null {
    const versions = vacancy.versions ?? vacancy.Versions ?? [];
    if (!Array.isArray(versions) || versions.length === 0) return null;
    const english = versions.find((v) => {
      const lang = (v?.language ?? '').toLowerCase();
      return lang === 'en' || lang === 'gb' || lang === 'eng' || lang.startsWith('en');
    });
    if (english && this.value(english.title, english.Title)) return english;
    const titled = versions.find((v) => this.value(v?.title, v?.Title));
    return titled ?? english ?? versions[0];
  }

  /** Pick the first department block (used for the job URL + company label). */
  private pickDepartment(vacancy: EasyCruitVacancy): EasyCruitDepartment | null {
    const departments = vacancy.departments ?? vacancy.Departments ?? [];
    if (!Array.isArray(departments) || departments.length === 0) return null;
    return departments[0];
  }

  /**
   * Build the public job-detail / apply page URL. Prefer the feed's explicit
   * `<VacancyURL>`; otherwise reconstruct the canonical
   * `{host}/vacancy/{vacancyId}/{departmentId}?iso=gb` form.
   */
  private buildJobUrl(
    vacancy: EasyCruitVacancy,
    department: EasyCruitDepartment | null,
    tenant: string,
    atsId: string,
  ): string | null {
    const explicit = this.value(department?.vacancyUrl, department?.VacancyURL);
    if (explicit && /^https?:\/\//i.test(explicit)) return explicit;

    const host = EASYCRUIT_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const deptId = (department?.id ?? '').toString().trim();
    const path = deptId
      ? `${EASYCRUIT_VACANCY_PATH}/${encodeURIComponent(atsId)}/${encodeURIComponent(deptId)}`
      : `${EASYCRUIT_VACANCY_PATH}/${encodeURIComponent(atsId)}`;
    return `${host}${path}?iso=${EASYCRUIT_DEFAULT_ISO}`;
  }

  /**
   * Synthesise a small HTML summary from the version's labelled fields so the
   * description pipeline (HTML / markdown / plain) has consistent input.
   */
  private buildDescriptionHtml(version: EasyCruitVacancyVersion | null): string | null {
    if (!version) return null;
    const parts: string[] = [];
    const heading = this.value(version.titleHeading, version.TitleHeading);
    if (heading) parts.push(`<p>${heading}</p>`);
    const rows: Array<[string, string | null]> = [
      ['Location', this.value(version.location, version.Location)],
      ['Region', this.value(version.region, version.Region)],
      ['Engagement', this.value(version.engagement, version.Engagement)],
      ['Hours', this.value(version.dailyHours, version.DailyHours)],
      ['Categories', this.value(version.categories, version.Categories)],
      ['Application deadline', this.value(version.applicationDeadline, version.ApplicationDeadline)],
    ];
    const present = rows.filter(([, v]) => !!v);
    if (present.length > 0) {
      parts.push(
        '<ul>' +
          present.map(([k, v]) => `<li><strong>${k}:</strong> ${v}</li>`).join('') +
          '</ul>',
      );
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Convert the synthesised job body per `descriptionFormat`. */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the EasyCruit tenant token from an explicit `companySlug` or from a
   * `companyUrl` (the first meaningful sub-domain label, else the trailing path
   * segment).
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        // A tenant host is `{tenant}.easycruit.com`: the first non-`www` label
        // is the tenant.
        const first = labels[0];
        if (first && first !== 'www' && first !== 'easycruit') return first;
        if (labels[1] && labels[1] !== 'easycruit') return labels[1];
        // Fall back to the trailing path segment for embed-style URLs.
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length > 0) return segments[segments.length - 1];
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  private deriveCompanyName(name: string | null, tenant: string): string {
    const base = (name && name.trim() ? name.trim() : tenant) || tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * EasyCruit exposes a free-text `Location` string plus a `Region` label;
   * `Region` maps to the region/state slot and `Location` to the city slot.
   */
  private extractLocation(version: EasyCruitVacancyVersion | null): LocationDto | null {
    if (!version) return null;
    const city = this.value(version.location, version.Location);
    const state = this.value(version.region, version.Region);
    if (!city && !state) return null;
    return new LocationDto({ city: city ?? null, state: state ?? null });
  }

  /** Use the version's category label (else the department name) as department. */
  private extractDepartment(
    version: EasyCruitVacancyVersion | null,
    department: EasyCruitDepartment | null,
  ): string | null {
    const cat = this.value(version?.categories, version?.Categories);
    if (cat) return cat;
    const name = this.value(department?.name, department?.Name);
    return name ?? null;
  }

  /** Detect remote roles from the location text, region, engagement, or title. */
  private detectRemote(version: EasyCruitVacancyVersion | null, title: string): boolean {
    const haystacks: Array<string | null | undefined> = [
      title,
      this.value(version?.location, version?.Location),
      this.value(version?.region, version?.Region),
      this.value(version?.engagement, version?.Engagement),
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('etätyö') ||
        v.includes('hjemmekontor') ||
        v.includes('distans') ||
        v.includes('work from home') ||
        v.includes('wfh')
      ) {
        return true;
      }
    }
    return false;
  }

  /** Parse an ISO-8601-ish date string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }

  /** First non-empty trimmed string among the supplied aliases, else null. */
  private value(...candidates: Array<string | null | undefined>): string | null {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  }
}
