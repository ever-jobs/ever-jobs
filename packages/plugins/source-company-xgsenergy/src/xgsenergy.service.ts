import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  parseLocationText,
} from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  XGSENERGY_CAREERS_URL,
  XGSENERGY_CFEMAIL_ATTR,
  XGSENERGY_CFEMAIL_HREF_RE,
  XGSENERGY_CFEMAIL_SELECTOR,
  XGSENERGY_COMPANY_NAME,
  XGSENERGY_CONTENT_SELECTOR,
  XGSENERGY_DEFAULT_TIMEOUT_SECONDS,
  XGSENERGY_HYBRID_RE,
  XGSENERGY_ITEM_SELECTOR,
  XGSENERGY_ORIGIN,
  XGSENERGY_TAB_ID_PREFIX,
  XGSENERGY_TITLE_LOC_MARKER,
  XGSENERGY_TITLE_LOC_VALUE,
  XGSENERGY_TITLE_SELECTOR,
} from './xgsenergy.constants';

@SourcePlugin({
  site: Site.XGSENERGY,
  name: XGSENERGY_COMPANY_NAME,
  category: 'company',
  companyDomains: ['xgsenergy.com'],
})
@Injectable()
export class XgsEnergyService implements IScraper {
  private readonly logger = new Logger(XgsEnergyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no accordion items on the XGS Energy careers page'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`XGS Energy: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`XGS Energy scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? XGSENERGY_DEFAULT_TIMEOUT_SECONDS,
    });

    const careersUrl = this.normalize(input.companyUrl) || XGSENERGY_CAREERS_URL;
    const res = await client.get<string>(careersUrl);
    return this.parseItems(cheerio.load(String(res.data ?? '')), careersUrl);
  }

  /** One `div.elementor-accordion-item` per role: tab title + tab content. */
  private parseItems($: cheerio.CheerioAPI, careersUrl: string): JobPostDto[] {
    const jobs: JobPostDto[] = [];
    $(XGSENERGY_ITEM_SELECTOR).each((_, el) => {
      const job = this.parseItem($, $(el), careersUrl);
      if (job) jobs.push(job);
    });
    return jobs;
  }

  private parseItem(
    $: cheerio.CheerioAPI,
    item: cheerio.Cheerio<AnyNode>,
    careersUrl: string,
  ): JobPostDto | null {
    const titleEl = item.find(XGSENERGY_TITLE_SELECTOR).first();
    const title = this.normalize(
      titleEl
        .clone()
        .find(`${XGSENERGY_TITLE_LOC_MARKER}, ${XGSENERGY_TITLE_LOC_VALUE}`)
        .remove()
        .end()
        .text(),
    );
    if (!title) return null;

    const locationFrag = this.normalize(
      titleEl.find(XGSENERGY_TITLE_LOC_VALUE).first().text(),
    );
    const { locations, hybrid } = this.locationFragments(locationFrag);
    const location = locations[0] ?? null;

    const content = item.find(XGSENERGY_CONTENT_SELECTOR).first();
    const description = htmlToPlainText(content.html() ?? '');

    const tabId = item
      .find(`[id^="${XGSENERGY_TAB_ID_PREFIX}"]`)
      .first()
      .attr('id');
    const jobUrl = tabId ? `${careersUrl.split('#')[0]}#${tabId}` : careersUrl;

    const applyUrl = this.applyEmail(content) ?? careersUrl;

    return new JobPostDto({
      id: `xgsenergy-${this.slug(title)}`,
      atsId: this.slug(title),
      site: Site.XGSENERGY,
      atsType: 'xgsenergy',
      title,
      companyName: XGSENERGY_COMPANY_NAME,
      companyUrl: XGSENERGY_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      applyUrl,
      location,
      ...(locations.length ? { locations } : {}),
      ...(description ? { description } : {}),
      ...(hybrid ? { workFromHomeType: 'Hybrid' } : {}),
    });
  }

  /**
   * `.acco-na` carries `/`-separated fragments: `Houston, TX / Hybrid`,
   * `Seattle, WA / Austin, TX / Houston, TX`. `Hybrid` is a work mode, not a
   * place; everything else goes through `parseLocationText`.
   */
  private locationFragments(raw: string): {
    locations: LocationDto[];
    hybrid: boolean;
  } {
    const locations: LocationDto[] = [];
    const seen = new Set<string>();
    let hybrid = false;
    for (const frag of raw.split('/')) {
      const text = frag.trim();
      if (!text) continue;
      if (XGSENERGY_HYBRID_RE.test(text)) {
        hybrid = true;
        continue;
      }
      const parsed = parseLocationText(text);
      const loc = parsed?.location;
      if (!loc) continue;
      const key = loc.displayLocation() || text;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(loc);
      if (parsed.workFromHomeType === 'Hybrid') hybrid = true;
    }
    return { locations, hybrid };
  }

  /**
   * Closing line of `.elementor-tab-content` is a Cloudflare-protected
   * mailto (`.__cf_email__[data-cfemail]` or an `email-protection#hex` href).
   * Falls back to a bare `mailto:` href.
   */
  private applyEmail(content: cheerio.Cheerio<AnyNode>): string | null {
    const cfemail = content.find(XGSENERGY_CFEMAIL_SELECTOR).first().attr(XGSENERGY_CFEMAIL_ATTR);
    const decoded = this.decodeCfEmail(cfemail);
    if (decoded) return `mailto:${decoded}`;

    const href = content.find('a[href*="email-protection"]').first().attr('href');
    const m = href ? XGSENERGY_CFEMAIL_HREF_RE.exec(href) : null;
    const decodedHref = this.decodeCfEmail(m?.[1]);
    if (decodedHref) return `mailto:${decodedHref}`;

    const mailto = content.find('a[href^="mailto:"]').first().attr('href');
    return mailto ?? null;
  }

  /** Cloudflare's email-protection hex: byte 0 = XOR key for bytes 1…n. */
  private decodeCfEmail(hex: string | undefined | null): string | null {
    if (!hex || hex.length < 4 || hex.length % 2 !== 0) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return out.includes('@') ? out : null;
  }

  private slug(title: string): string {
    return (
      this.normalize(title)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'role'
    );
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
        (job.locations?.length ? job.locations : job.location ? [job.location] : []).some((loc) =>
          this.normalize(loc.displayLocation()).toLowerCase().includes(locationTerm),
        ),
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
