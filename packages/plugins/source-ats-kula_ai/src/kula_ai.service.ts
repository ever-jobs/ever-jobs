import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  CompensationDto,
  DescriptionFormat,
  getCompensationInterval,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  JobPostingLd,
  jobPostingLdToCompensation,
  markdownConverter,
  parseJobPostingLd,
  resolveCompanyUrl,
  toDateOnly,
  attachRawCapture,
} from '@ever-jobs/common';
import {
  KULA_AI_BASE_URL,
  KULA_AI_DEFAULT_RESULTS_WANTED,
  KULA_AI_DEFAULT_DESCRIPTION_DEPTH,
  KULA_AI_DESCRIPTION_BUDGET,
  KULA_AI_DETAIL_CONCURRENCY,
  KULA_AI_ERR_BAD_INPUT,
  KULA_AI_ERR_FETCH_FAILED,
  KULA_AI_ERR_NAV_FAILED,
  KULA_AI_ERR_UNAVAILABLE,
  KULA_AI_GOTO_TIMEOUT_MS,
  KULA_AI_LAUNCH_ARGS,
  KULA_AI_SETTLE_MS,
} from './kula_ai.constants';
import { KulaAiListRow, KulaAiXmlItem, KulaAiXmlLocation, KulaAiXmlSalary } from './kula_ai.types';

/**
 * Kula AI multi-tenant ATS scraper.
 *
 * 1. Fetch the public XML feed at `careers.kula.ai/<account>/feed` as canonical
 *    for Kula-specific fields (`employmentType`, `workplace`, `location`, `salary` interval).
 * 2. Render `careers.kula.ai/<account>` with Playwright to discover every job ID
 *    (the rendered list can expose jobs the 25-item XML feed omits).
 * 3. Fetch each `/<account>/<id>/` detail page and parse its `application/ld+json`
 *    `JobPosting` for `description` and `baseSalary` min/max.
 * 4. Merge feed and JSON-LD records per field.
 */
@SourcePlugin({
  site: Site.KULA_AI,
  name: 'Kula AI',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class KulaAiService implements IScraper {
  private readonly logger = new Logger(KulaAiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const account = this.resolveAccount(input);
    if (!account) {
      this.logger.warn(`${KULA_AI_ERR_BAD_INPUT} — missing companySlug or careers.kula.ai companyUrl`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('bad_input', 'Missing companySlug or companyUrl for Kula AI board'),
      );
    }

    const resultsWanted = input.resultsWanted ?? KULA_AI_DEFAULT_RESULTS_WANTED;
    const depthKey = this.resolveDepth(input.descriptionDepth);
    const detailBudget = KULA_AI_DESCRIPTION_BUDGET[depthKey];
    const client = createHttpClient(input);

    try {
      const feedMap = await this.fetchFeed(client, account);
      const listRows = await this.renderList(account, input);
      const listIds = listRows.map((r) => r.id);
      const feedIds = [...feedMap.keys()];
      const allIds = this.mergeIds(listIds, feedIds);

      const detailLimit = Number.isFinite(detailBudget) ? Math.min(allIds.length, detailBudget) : allIds.length;
      const detailIds = detailBudget === 0 ? [] : allIds.slice(0, detailLimit);
      const detailMap = detailIds.length ? await this.fetchDetails(client, account, detailIds) : new Map();

      const rowMap = new Map(listRows.map((r) => [r.id, r]));
      const allJobs: JobPostDto[] = [];
      for (const id of allIds) {
        const job = this.toJobPost(
          id,
          feedMap.get(id),
          detailMap.get(id),
          rowMap.get(id),
          account,
          input.descriptionFormat,
        );
        if (job && this.matchesFilters(job, input)) {
          allJobs.push(job);
        }
      }

      const offset = input.offset ?? 0;
      const jobs = allJobs.slice(offset, offset + resultsWanted);

      this.logger.log(`Kula AI (${account}): ${allJobs.length} matched, returning ${jobs.length}`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Kula AI (${account}) scrape error: ${err?.message ?? err}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private resolveAccount(input: ScraperInputDto): string | null {
    if (input.companySlug?.trim()) {
      return input.companySlug.trim();
    }
    if (input.companyUrl) {
      const resolved = resolveCompanyUrl(input.companyUrl);
      if (resolved.site === Site.KULA_AI && resolved.slug) {
        return resolved.slug;
      }
    }
    return null;
  }

  private resolveDepth(raw: string | undefined): string {
    if (raw && raw in KULA_AI_DESCRIPTION_BUDGET) {
      return raw;
    }
    return KULA_AI_DEFAULT_DESCRIPTION_DEPTH;
  }

  private async loadPlaywright(): Promise<any | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return await Function('specifier', 'return import(specifier)')('playwright');
    } catch (err: any) {
      this.logger.warn(
        `${KULA_AI_ERR_UNAVAILABLE} — playwright not installed (${err?.message ?? err}). Run \`npm install playwright\` and \`npx playwright install chromium\` to enable the rendered list page.`,
      );
      return null;
    }
  }

  private async fetchFeed(client: any, account: string): Promise<Map<string, KulaAiXmlItem>> {
    const feedUrl = `${KULA_AI_BASE_URL}/${account}/feed`;
    try {
      const response = await client.get(feedUrl);
      const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!xml) {
        this.logger.warn(`${KULA_AI_ERR_FETCH_FAILED} — empty XML feed for ${account}`);
        return new Map();
      }
      return this.parseFeed(xml, account);
    } catch (err: any) {
      this.logger.warn(`${KULA_AI_ERR_FETCH_FAILED} — ${err?.message ?? err}`);
      return new Map();
    }
  }

  private parseFeed(xml: string, account: string): Map<string, KulaAiXmlItem> {
    const map = new Map<string, KulaAiXmlItem>();
    const itemBlocks = xml.split(/<item>/i).slice(1);
    for (const block of itemBlocks) {
      const itemContent = (block.split(/<\/item>/i)[0] ?? block).trim();
      if (!itemContent) continue;

      const title = this.extractXmlTag(itemContent, 'title');
      const link = this.extractXmlTag(itemContent, 'link');
      const guid = this.extractXmlTag(itemContent, 'guid');
      const id = link ? this.extractIdFromLink(link, account) : undefined;
      if (!id) continue;

      map.set(id, {
        id,
        title: title ?? '',
        link: link ?? '',
        guid: guid ?? '',
        pubDate: this.extractXmlTag(itemContent, 'pubDate'),
        category: this.extractXmlTag(itemContent, 'category'),
        description: this.extractXmlTag(itemContent, 'description'),
        employmentType: this.extractXmlTag(itemContent, 'job:employmentType'),
        workplace: this.extractXmlTag(itemContent, 'job:workplace'),
        location: this.parseXmlLocation(this.extractXmlTag(itemContent, 'job:location')),
        salary: this.parseXmlSalary(this.extractXmlTag(itemContent, 'job:salary')),
      });
    }
    return map;
  }

  private extractXmlTag(xml: string, tagName: string): string | undefined {
    const cdataRegex = new RegExp(
      `<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`,
      'i',
    );
    const cdataMatch = cdataRegex.exec(xml);
    if (cdataMatch?.[1]) {
      const value = cdataMatch[1].trim();
      return value || undefined;
    }

    const plainRegex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const plainMatch = plainRegex.exec(xml);
    if (plainMatch?.[1]) {
      const value = plainMatch[1].trim();
      return value || undefined;
    }
    return undefined;
  }

  private parseXmlLocation(inner?: string): KulaAiXmlLocation {
    if (!inner) return {};
    return {
      officeName: this.extractXmlTag(inner, 'job:officeName'),
      remote: this.extractXmlTag(inner, 'job:remote'),
      city: this.extractXmlTag(inner, 'job:city'),
      state: this.extractXmlTag(inner, 'job:state'),
      country: this.extractXmlTag(inner, 'job:country'),
      isHQ: this.extractXmlTag(inner, 'job:isHQ'),
    };
  }

  private parseXmlSalary(inner?: string): KulaAiXmlSalary {
    if (!inner) return {};
    return {
      currency: this.extractXmlTag(inner, 'job:currency'),
      minAmount: this.extractXmlTag(inner, 'job:minAmount'),
      maxAmount: this.extractXmlTag(inner, 'job:maxAmount'),
      interval: this.extractXmlTag(inner, 'job:interval'),
      type: this.extractXmlTag(inner, 'job:type'),
    };
  }

  private extractIdFromLink(link: string, account: string): string | undefined {
    try {
      const url = new URL(link.startsWith('http') ? link : `${KULA_AI_BASE_URL}${link}`);
      const segments = url.pathname.split('/').filter(Boolean);
      const accountIndex = segments.findIndex((s) => s.toLowerCase() === account.toLowerCase());
      if (accountIndex >= 0 && segments[accountIndex + 1]) {
        return segments[accountIndex + 1];
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  private async renderList(account: string, input: ScraperInputDto): Promise<KulaAiListRow[]> {
    const playwrightModule = await this.loadPlaywright();
    if (!playwrightModule) {
      return [];
    }

    let browser: any = null;
    try {
      browser = await playwrightModule.chromium.launch({
        headless: true,
        args: [...KULA_AI_LAUNCH_ARGS],
      });
      const page = await browser.newPage();
      attachRawCapture(page);
      const listUrl = input.companyUrl?.startsWith(`${KULA_AI_BASE_URL}/${account}`)
        ? input.companyUrl
        : `${KULA_AI_BASE_URL}/${account}`;

      await page.goto(listUrl, {
        waitUntil: 'networkidle',
        timeout: input.requestTimeout ? input.requestTimeout * 1000 : KULA_AI_GOTO_TIMEOUT_MS,
      });
      await this.sleep(KULA_AI_SETTLE_MS);
      const html = await page.content();
      return this.parseListHtml(html, account);
    } catch (err: any) {
      this.logger.warn(`${KULA_AI_ERR_NAV_FAILED} — ${err?.message ?? err}`);
      return [];
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore close errors
        }
      }
    }
  }

  private parseListHtml(html: string, account: string): KulaAiListRow[] {
    const rows: KulaAiListRow[] = [];
    const seen = new Set<string>();
    const $ = cheerio.load(html);

    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      try {
        const fullHref = href.startsWith('http') ? href : `${KULA_AI_BASE_URL}${href}`;
        const url = new URL(fullHref);
        const segments = url.pathname.split('/').filter(Boolean);
        const accountIndex = segments.findIndex((s) => s.toLowerCase() === account.toLowerCase());
        if (accountIndex < 0 || accountIndex + 1 >= segments.length) return;

        const id = segments[accountIndex + 1];
        if (!/^\d+$/.test(id) || seen.has(id)) return;
        seen.add(id);

        const $a = $(el);
        const $container = $a.closest('div');
        const pTexts = $container
          .find('p')
          .map((_, p) =>
            $(p)
              .text()
              .replace(/\s+/g, ' ')
              .trim(),
          )
          .get()
          .filter((t) => t.length > 0 && !t.toLowerCase().startsWith('apply'));

        const title = pTexts.find((t) => !t.includes('•'));
        const meta = pTexts.find((t) => t.includes('•'));

        let department: string | undefined;
        let location: string | undefined;
        let employmentType: string | undefined;
        let workplace: string | undefined;

        if (meta) {
          const parts = meta.split('•').map((s) => s.trim()).filter(Boolean);
          if (parts.length >= 4) {
            [department, location, employmentType, workplace] = parts;
          } else if (parts.length === 3) {
            [location, employmentType, workplace] = parts;
          } else if (parts.length === 2) {
            [location, employmentType] = parts;
          }
        }

        rows.push({
          id,
          title: title ? title.replace(/\s+/g, ' ').trim() : undefined,
          department,
          location,
          employmentType,
          workplace,
          applyUrl: fullHref,
        });
      } catch {
        // skip malformed anchors
      }
    });

    return rows;
  }

  private async fetchDetails(client: any, account: string, ids: string[]): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    for (let i = 0; i < ids.length; i += KULA_AI_DETAIL_CONCURRENCY) {
      const chunk = ids.slice(i, i + KULA_AI_DETAIL_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((id) => this.fetchDetail(client, account, id)),
      );
      results.forEach((res, idx) => {
        if (res.status === 'fulfilled' && res.value) {
          map.set(chunk[idx], res.value);
        }
      });
    }
    return map;
  }

  private async fetchDetail(client: any, account: string, id: string): Promise<any | null> {
    const detailUrl = `${KULA_AI_BASE_URL}/${account}/${id}/`;
    try {
      const response = await client.get(detailUrl);
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      const postings = parseJobPostingLd(html);
      return postings[0] ?? null;
    } catch (err: any) {
      this.logger.warn(`Kula AI detail fetch failed for ${id}: ${err?.message ?? err}`);
      return null;
    }
  }

  private mergeIds(listIds: string[], feedIds: string[]): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const add = (id: string) => {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    };
    for (const id of listIds) add(id);
    for (const id of feedIds) add(id);
    return order.sort((a, b) => Number(a) - Number(b));
  }

  private toJobPost(
    id: string,
    xmlItem: KulaAiXmlItem | undefined,
    ld: any,
    row: KulaAiListRow | undefined,
    account: string,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    const detailUrl = `${KULA_AI_BASE_URL}/${account}/${id}/`;
    const title = (xmlItem?.title ?? ld?.title ?? row?.title ?? '').trim() || '(untitled)';
    const companyName = (ld?.hiringOrganizationName ?? this.titleCase(account)).trim();

    const descriptionHtml = ld?.description ?? xmlItem?.description;
    const description = descriptionHtml ? this.convertDescription(descriptionHtml, descriptionFormat) : null;

    const applyUrl = xmlItem?.link ?? ld?.applyUrl ?? row?.applyUrl ?? detailUrl;

    const location = this.buildLocation(xmlItem?.location, ld?.locations ?? [], ld?.remote);
    const compensation = this.mergeCompensation(xmlItem?.salary, ld?.baseSalary);

    const employmentTypeRaw = xmlItem?.employmentType ?? ld?.employmentType ?? row?.employmentType;
    const workplaceRaw = xmlItem?.workplace ?? row?.workplace;
    const jobType = this.buildJobType(title, employmentTypeRaw);

    const isRemote = this.buildIsRemote(workplaceRaw, xmlItem?.location?.remote, ld?.remote);
    const workFromHomeType = this.buildWorkFromHomeType(workplaceRaw, isRemote);

    const datePostedRaw = ld?.datePosted ?? xmlItem?.pubDate;
    const datePosted = datePostedRaw ? toDateOnly(datePostedRaw) : null;

    return new JobPostDto({
      id: `kula_ai-${id}`,
      atsId: id,
      atsType: 'kula_ai',
      site: Site.KULA_AI,
      title,
      companyName,
      jobUrl: detailUrl,
      jobUrlDirect: applyUrl !== detailUrl ? applyUrl : null,
      companyUrl: `${KULA_AI_BASE_URL}/${account}`,
      location,
      description,
      compensation,
      jobType,
      isRemote,
      workFromHomeType,
      datePosted,
      employmentType: employmentTypeRaw,
      department: xmlItem?.category ?? row?.department,
    });
  }

  private buildLocation(
    xmlLoc: KulaAiXmlLocation | undefined,
    ldLocations: any[],
    ldRemote: boolean | undefined,
  ): LocationDto | null {
    const loc = new LocationDto();

    if (xmlLoc) {
      if (xmlLoc.city?.trim()) loc.city = xmlLoc.city.trim();
      if (xmlLoc.state?.trim()) loc.state = xmlLoc.state.trim();
      if (xmlLoc.country?.trim()) loc.country = xmlLoc.country.trim();
      if (!loc.city && xmlLoc.officeName?.trim()) loc.city = xmlLoc.officeName.trim();
    }

    const ldLoc = ldLocations[0];
    if (ldLoc) {
      if (!loc.city && ldLoc.city) loc.city = ldLoc.city;
      if (!loc.state && ldLoc.region) loc.state = ldLoc.region;
      if (!loc.country && ldLoc.country) loc.country = ldLoc.country;
    }

    if (ldRemote && !loc.country) {
      loc.country = 'Remote';
    }

    if (!loc.city && !loc.state && !loc.country) {
      return null;
    }
    return loc;
  }

  private mergeCompensation(xmlSalary: KulaAiXmlSalary | undefined, ldSalary: any): CompensationDto | null {
    const xmlComp = this.xmlSalaryToCompensation(xmlSalary);
    const ldComp = jobPostingLdToCompensation(ldSalary);

    if (!xmlComp && !ldComp) {
      return null;
    }

    return new CompensationDto({
      minAmount: ldComp?.minAmount ?? xmlComp?.minAmount,
      maxAmount: ldComp?.maxAmount ?? xmlComp?.maxAmount,
      currency: ldComp?.currency || xmlComp?.currency || 'USD',
      interval: xmlComp?.interval ?? ldComp?.interval,
    });
  }

  private xmlSalaryToCompensation(salary?: KulaAiXmlSalary): CompensationDto | null {
    if (!salary) return null;
    const min = this.parseNumber(salary.minAmount);
    const max = this.parseNumber(salary.maxAmount);
    if (min == null && max == null) return null;

    const interval = salary.interval ? getCompensationInterval(salary.interval) : null;
    return new CompensationDto({
      minAmount: min,
      maxAmount: max,
      currency: salary.currency,
      interval,
    });
  }

  private parseNumber(value: string | number | undefined): number | undefined {
    if (value == null || value === '') return undefined;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  private buildJobType(title: string, employmentTypeRaw?: string): JobType[] | null {
    const types: JobType[] = [];
    if (employmentTypeRaw) {
      const cleaned = employmentTypeRaw.replace(/_/g, '');
      const t = getJobTypeFromString(cleaned);
      if (t) types.push(t);
    }

    if (/\bintern(?:ship)?\b/i.test(title) && !types.includes(JobType.INTERNSHIP)) {
      types.push(JobType.INTERNSHIP);
    }

    return types.length ? types : null;
  }

  private buildIsRemote(
    workplaceRaw: string | undefined,
    xmlRemote: string | undefined,
    ldRemote: boolean | undefined,
  ): boolean {
    if (workplaceRaw?.toUpperCase() === 'REMOTE') return true;
    if (workplaceRaw?.toUpperCase() === 'OFFICE' || workplaceRaw?.toUpperCase() === 'ON-SITE') return false;
    if (workplaceRaw?.toUpperCase() === 'HYBRID') return false;
    if (xmlRemote != null) return xmlRemote.toLowerCase() === 'true';
    if (ldRemote != null) return ldRemote;
    return false;
  }

  private buildWorkFromHomeType(workplaceRaw: string | undefined, isRemote: boolean): string | null {
    const up = workplaceRaw?.toUpperCase() ?? '';
    if (up.includes('REMOTE')) return 'Remote';
    if (up.includes('HYBRID')) return 'Hybrid';
    if ((up.includes('ON') && up.includes('SITE')) || up.includes('OFFICE')) return 'On-site';
    return isRemote ? 'Remote' : 'On-site';
  }

  private convertDescription(html: string, format?: DescriptionFormat): string | null {
    if (format === DescriptionFormat.PLAIN) {
      return htmlToPlainText(html);
    }
    if (format === DescriptionFormat.HTML) {
      return html;
    }
    return markdownConverter(html);
  }

  private matchesFilters(job: JobPostDto, input: ScraperInputDto): boolean {
    if (input.searchTerm) {
      const term = input.searchTerm.toLowerCase();
      const haystack = [
        job.title,
        job.companyName,
        job.description,
        job.location?.displayLocation(),
        job.department,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }

    if (input.location && job.location) {
      if (!job.location.displayLocation().toLowerCase().includes(input.location.toLowerCase())) {
        return false;
      }
    }

    if (input.jobType && job.jobType) {
      if (!job.jobType.includes(input.jobType)) return false;
    }

    if (input.isRemote != null && job.isRemote !== input.isRemote) {
      return false;
    }

    if (input.hoursOld && job.datePosted) {
      const posted = typeof job.datePosted === 'string' ? new Date(job.datePosted) : job.datePosted;
      if (posted && !Number.isNaN(posted.getTime())) {
        const hours = (Date.now() - posted.getTime()) / 36e5;
        if (hours > input.hoursOld) return false;
      }
    }

    return true;
  }

  private titleCase(slug: string): string {
    return slug
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
