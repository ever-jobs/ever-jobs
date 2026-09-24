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
  htmlToPlainText,
  parseLocationText,
  pinUrlToHosts,
  resolveCompensation,
} from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  SOUNDRYX_ALLOWED_HOSTS,
  SOUNDRYX_APPLY_HEADING_RE,
  SOUNDRYX_CAREERS_URL,
  SOUNDRYX_CFEMAIL_ATTR,
  SOUNDRYX_CFEMAIL_HREF_RE,
  SOUNDRYX_CFEMAIL_SELECTOR,
  SOUNDRYX_COMPANY_NAME,
  SOUNDRYX_COMPENSATION_HEADING_RE,
  SOUNDRYX_DEFAULT_TIMEOUT_SECONDS,
  SOUNDRYX_DOC_SELECTOR,
  SOUNDRYX_FOOTNOTES_SELECTOR,
  SOUNDRYX_LOCATION_RE,
  SOUNDRYX_ONSITE_RE,
  SOUNDRYX_ORIGIN,
  SOUNDRYX_TILE_SELECTOR,
  SOUNDRYX_TILE_TITLE_SELECTOR,
} from './soundryx.constants';
import { SoundryxJobRef } from './soundryx.types';

@SourcePlugin({
  site: Site.SOUNDRYX,
  name: SOUNDRYX_COMPANY_NAME,
  category: 'company',
  companyDomains: ['soundryx.com'],
})
@Injectable()
export class SoundryxService implements IScraper {
  private readonly logger = new Logger(SoundryxService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job tiles on the Soundryx careers page'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Soundryx: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Soundryx scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? SOUNDRYX_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: SOUNDRYX_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const indexRes = await client.get<string>(careersUrl);
    const refs = this.parseIndex(cheerio.load(String(indexRes.data ?? '')), careersUrl);
    if (refs.length === 0) return [];

    const jobs: JobPostDto[] = [];
    for (const ref of refs) {
      const res = await client.get<string>(ref.url).catch(() => null);
      if (!res) continue;
      const job = this.parseDetail(cheerio.load(String(res.data ?? '')), ref);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /**
   * The careers index to fetch: the caller's `companyUrl` when it is on
   * soundryx.com (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return SOUNDRYX_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, SOUNDRYX_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Soundryx: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${SOUNDRYX_ALLOWED_HOSTS.join(', ')}`,
      );
      return SOUNDRYX_CAREERS_URL;
    }
    return pinned;
  }

  /**
   * `a.srx-tile.is-link` tiles on the index. Each tile's detail page is
   * fetched next, so a tile linking off soundryx.com is skipped rather than
   * followed (Spec 1689) — the index is third-party HTML.
   */
  private parseIndex($: cheerio.CheerioAPI, careersUrl: string): SoundryxJobRef[] {
    const refs: SoundryxJobRef[] = [];
    $(SOUNDRYX_TILE_SELECTOR).each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href')?.trim();
      const title = this.normalize($a.find(SOUNDRYX_TILE_TITLE_SELECTOR).first().text());
      if (!href || !title) return;
      const url = pinUrlToHosts(this.resolveUrl(href, careersUrl), SOUNDRYX_ALLOWED_HOSTS, {
        upgradeHttp: true,
      });
      if (!url) {
        this.logger.debug(`Soundryx: skipping off-site tile link \`${href.slice(0, 200)}\``);
        return;
      }
      const slug = url.match(/\/careers\/([^/]+)\/?$/)?.[1];
      if (!slug) return;
      const meta = this.normalize($a.find('p').first().text());
      refs.push({ slug, title, meta, url });
    });
    return refs;
  }

  private parseDetail($: cheerio.CheerioAPI, ref: SoundryxJobRef): JobPostDto | null {
    const doc = $(SOUNDRYX_DOC_SELECTOR).first();
    if (!doc.length) return null;

    // h1 is "Title<br/>(meta)" — take the first line only.
    const h1 = doc.find('h1').first();
    const title =
      this.normalize(h1.contents().first().text()) || ref.title;
    if (!title) return null;

    const { text: locationText, onsite } = this.locationLine($, doc);
    const parsed = locationText ? parseLocationText(locationText) : null;
    const location = parsed?.location ?? null;

    const docClone = doc.clone();
    docClone.find(SOUNDRYX_FOOTNOTES_SELECTOR).remove();
    const description = htmlToPlainText(docClone.html() ?? '');

    const compensation = this.compensation($, doc);
    const applyUrl = this.applyEmail($, doc) ?? ref.url;

    return new JobPostDto({
      id: `soundryx-${ref.slug}`,
      atsId: ref.slug,
      site: Site.SOUNDRYX,
      atsType: 'soundryx',
      title,
      companyName: SOUNDRYX_COMPANY_NAME,
      companyUrl: SOUNDRYX_ORIGIN,
      jobUrl: ref.url,
      jobUrlDirect: ref.url,
      applyUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(description ? { description } : {}),
      ...(compensation ? { compensation } : {}),
      ...(onsite ? { workFromHomeType: 'On Site' } : {}),
    });
  }

  /**
   * `<p><strong>Location</strong>: Los Angeles, CA (onsite)</p>` — the text
   * after the label is the location; the parenthetical is the work mode.
   */
  private locationLine(
    $: cheerio.CheerioAPI,
    doc: cheerio.Cheerio<AnyNode>,
  ): { text: string | null; onsite: boolean } {
    let text: string | null = null;
    let onsite = false;
    doc.find('p strong').each((_, el) => {
      if (text !== null) return;
      const label = $(el).text().trim();
      if (!SOUNDRYX_LOCATION_RE.test(label)) return;
      const raw = $(el).parent().text();
      const body = raw.replace(/^\s*Location\s*:/i, '').trim();
      onsite = SOUNDRYX_ONSITE_RE.test(body);
      text = this.stripParentheticals(body).replace(/\s+/g, ' ').trim() || null;
    });
    return { text, onsite };
  }

  /**
   * Replace every `(…)` with a space — the same result as the fork's
   * `replace(/\s*\([^)]*\)\s*\/g, ' ')` once whitespace is collapsed, in one
   * linear pass (Spec 1689). The regex's unanchored `\s*` was quadratic on a
   * long whitespace run, and `[^)]*` rescanned to the end for every unclosed
   * `(`; here the first `(` without a `)` after it ends the search.
   */
  private stripParentheticals(value: string): string {
    let out = '';
    let from = 0;
    for (;;) {
      const open = value.indexOf('(', from);
      if (open < 0) break;
      const close = value.indexOf(')', open + 1);
      if (close < 0) break;
      out += `${value.slice(from, open)} `;
      from = close + 1;
    }
    return out + value.slice(from);
  }

  /** `h2#compensation` → the sibling `ul` text → resolveCompensation. */
  private compensation(
    $: cheerio.CheerioAPI,
    doc: cheerio.Cheerio<AnyNode>,
  ) {
    const heading = doc
      .find('h2')
      .filter((_, el) => SOUNDRYX_COMPENSATION_HEADING_RE.test($(el).text().trim()))
      .first();
    if (!heading.length) return null;
    const list = heading.nextAll('ul').first();
    const text = this.normalize(list.text());
    return text ? resolveCompensation({ text }) : null;
  }

  /**
   * `h2#apply-now` → Cloudflare `data-cfemail` payload (first byte is the XOR
   * key for the rest) or a `/cdn-cgi/l/email-protection#hex` href. Falls back
   * to a bare `mailto:` href.
   */
  private applyEmail(
    $: cheerio.CheerioAPI,
    doc: cheerio.Cheerio<AnyNode>,
  ): string | null {
    const heading = doc
      .find('h2')
      .filter((_, el) => SOUNDRYX_APPLY_HEADING_RE.test($(el).text().trim()))
      .first();
    const scope = heading.length ? heading.parent() : doc;

    const cfemail = scope.find(SOUNDRYX_CFEMAIL_SELECTOR).first().attr(SOUNDRYX_CFEMAIL_ATTR);
    const decoded = this.decodeCfEmail(cfemail);
    if (decoded) return `mailto:${decoded}`;

    const href = scope
      .find('a[href*="email-protection"]')
      .first()
      .attr('href');
    const m = href ? SOUNDRYX_CFEMAIL_HREF_RE.exec(href) : null;
    const decodedHref = this.decodeCfEmail(m?.[1]);
    if (decodedHref) return `mailto:${decodedHref}`;

    const mailto = scope.find('a[href^="mailto:"]').first().attr('href');
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

  private resolveUrl(href: string, pageUrl: string): string {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return href.startsWith('http') ? href : `${SOUNDRYX_ORIGIN}${href}`;
    }
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

  private nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.split(String.fromCharCode(160)).join(' ').replace(/\s+/g, ' ').trim();
  }
}
