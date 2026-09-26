import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import {
  BrowserPool,
  createHttpClient,
  describeUrlForLog,
  parseLocationText,
  pinUrlToHosts,
} from '@ever-jobs/common';
import type { Page } from 'playwright';
import {
  MUNDANE_AIRTABLE_HOSTS,
  MUNDANE_AIRTABLE_HYDRATE_MS,
  MUNDANE_ALLOWED_HOSTS,
  MUNDANE_APPLY_HOSTS,
  MUNDANE_COMPANY_NAME,
  MUNDANE_DEFAULT_TIMEOUT_SECONDS,
  MUNDANE_JOB_ENTRY_RE,
  MUNDANE_JOIN_URL,
  MUNDANE_MAX_DETAIL_RENDERS,
  MUNDANE_ORIGIN,
  readMundaneClosePoolAfterScrape,
} from './mundane-co.constants';
import { MundaneJobEntry } from './mundane-co.types';

@SourcePlugin({
  site: Site.MUNDANE_CO,
  name: 'Mundane',
  category: 'company',
  companyDomains: ['mundane.co'],
})
@Injectable()
export class MundaneCoService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(MundaneCoService.name);

  /**
   * The shared browser pool is process-global, so it is closed on shutdown
   * only — the same hook every other browser plugin uses (Spec 1689).
   */
  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job entries found in the Mundane careers bundle'),
        );
      }

      await this.attachDescriptions(jobs, input);

      const out = this.applyInput(jobs, input);
      this.logger.log(`Mundane: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Mundane scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    } finally {
      // Opt-in only (MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE=true): the
      // fork closed the process-global pool here on every scrape, which
      // killed every other plugin's in-flight browser scrape.
      if (readMundaneClosePoolAfterScrape()) {
        await BrowserPool.close().catch(() => undefined);
      }
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? MUNDANE_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: MUNDANE_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const shellRes = await client.get<string>(careersUrl);
    const bundleUrl = this.bundleUrl(String(shellRes.data ?? ''));
    if (!bundleUrl) return [];

    const bundleRes = await client.get<string>(bundleUrl);
    const entries = this.parseBundleJobs(String(bundleRes.data ?? ''));
    return entries
      .map((entry) => this.toJobPost(entry))
      .filter((job): job is JobPostDto => job !== null);
  }

  /**
   * The careers page to fetch: the caller's `companyUrl` when it is on
   * mundane.co (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return MUNDANE_JOIN_URL;
    const pinned = pinUrlToHosts(requested, MUNDANE_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Mundane: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${MUNDANE_ALLOWED_HOSTS.join(', ')}`,
      );
      return MUNDANE_JOIN_URL;
    }
    return pinned;
  }

  /** `/assets/index-{hash}.js` referenced by the careers shell. */
  private bundleUrl(shellHtml: string): string | null {
    const m = /src="(\/assets\/[^"]+\.js)"/.exec(shellHtml);
    if (!m) return null;
    return `${MUNDANE_ORIGIN}${m[1]}`;
  }

  private parseBundleJobs(bundleJs: string): MundaneJobEntry[] {
    const out: MundaneJobEntry[] = [];
    for (const m of bundleJs.matchAll(MUNDANE_JOB_ENTRY_RE)) {
      const url = this.unescapeJs(m[4]);
      if (!this.hostIn(url, MUNDANE_APPLY_HOSTS)) continue;
      const title = this.normalize(this.unescapeJs(m[1]));
      if (!title) continue;
      out.push({
        title,
        category: this.unescapeJs(m[2]),
        location: this.unescapeJs(m[3]),
        url,
      });
    }
    return out;
  }

  /** Decode the escapes a bundler emits inside double-quoted string literals. */
  private unescapeJs(raw: string): string {
    return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_m, esc: string) => {
      if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16));
      switch (esc) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        default: return esc; // \" \' \\ \/ etc.
      }
    });
  }

  private toJobPost(entry: MundaneJobEntry): JobPostDto | null {
    const atsId =
      this.linkedinJobId(entry.url) ?? this.airtableFormId(entry.url) ?? this.slugFromTitle(entry.title);
    const parsed = entry.location ? parseLocationText(entry.location) : null;
    const location = parsed?.location ?? null;
    const jobType = /\bintern(?:ship)?\b/i.test(entry.title) ? JobType.INTERNSHIP : null;
    const jobUrl = this.cleanUrl(entry.url);

    return new JobPostDto({
      id: `mundane_co-${atsId}`,
      atsId,
      site: Site.MUNDANE_CO,
      atsType: 'mundane_co',
      title: entry.title,
      companyName: MUNDANE_COMPANY_NAME,
      companyUrl: MUNDANE_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(entry.category ? { department: this.normalize(entry.category) } : {}),
      jobType: jobType ? [jobType] : null,
    });
  }

  /**
   * Descriptions live on the Airtable shared forms behind the apply links.
   * Each form is a client-rendered hyperbase SPA, so the description is read
   * from the rendered DOM. LinkedIn apply links are never fetched.
   *
   * Only https airtable.com form URLs are opened (Spec 1689: the host is
   * checked on the parsed URL, not with an unanchored regex), and the page and
   * context this scrape opened are closed when it is done — never the shared
   * pool, which other plugins are using.
   */
  private async attachDescriptions(jobs: JobPostDto[], input: ScraperInputDto): Promise<void> {
    const targets: { job: JobPostDto; url: string }[] = [];
    for (const job of jobs) {
      if (targets.length >= MUNDANE_MAX_DETAIL_RENDERS) break;
      const url = this.airtableFormUrl(job.jobUrl ?? '');
      if (url) targets.push({ job, url });
    }
    if (targets.length === 0) return;

    const proxy = input.proxies?.[0] ?? undefined;
    const timeoutMs = (input.requestTimeout ?? MUNDANE_DEFAULT_TIMEOUT_SECONDS) * 1000;
    const page = await BrowserPool.getPage({ stealth: true, proxy });

    try {
      for (const { job, url } of targets) {
        try {
          await BrowserPool.navigate(page, url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          await this.delay(MUNDANE_AIRTABLE_HYDRATE_MS);
          const description = (await page.evaluate(AIRTABLE_DESCRIPTION_JS)) as string | null;
          const text = this.normalize(description ?? '');
          if (text) job.description = text;
        } catch (error) {
          this.logger.warn(
            `Mundane: description render failed for ${url}: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      await this.closeOwnPage(page);
    }
  }

  /**
   * Close the page this scrape opened, and its context when that context is
   * this page's own (a non-persistent context from `browser.newContext()`,
   * whose `browser()` is non-null). A persistent context is shared by every
   * plugin with the same launch identity, so it is left to `BrowserPool`.
   */
  private async closeOwnPage(page: Page): Promise<void> {
    const context = page.context();
    await page.close().catch(() => undefined);
    if (context.browser() !== null) {
      await context.close().catch(() => undefined);
    }
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.description, job.department].some((value) =>
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

  private linkedinJobId(url: string): string | null {
    const parsed = this.parseHttpUrl(url);
    if (!parsed || !this.hostIn(parsed, ['linkedin.com'])) return null;
    const m = /^\/jobs\/view\/(\d+)/.exec(parsed.pathname);
    return m ? m[1] : null;
  }

  private airtableFormId(url: string): string | null {
    const parsed = this.parseHttpUrl(url);
    if (!parsed || !this.hostIn(parsed, MUNDANE_AIRTABLE_HOSTS)) return null;
    const m = /^\/[^/]+\/(pag[a-zA-Z0-9]+)/.exec(parsed.pathname);
    return m ? m[1] : null;
  }

  /**
   * The https URL to open for an Airtable shared form, or `null` when `url`
   * is not one. The host is checked on the parsed URL (Spec 1689) — the
   * fork's unanchored `/airtable\.com\/…/` also passed
   * `http://10.0.0.5/airtable.com/x/pagX`.
   */
  private airtableFormUrl(url: string): string | null {
    if (!this.airtableFormId(url)) return null;
    return pinUrlToHosts(url, MUNDANE_AIRTABLE_HOSTS, { upgradeHttp: true });
  }

  /** An http(s) URL, parsed; `null` for anything else. */
  private parseHttpUrl(url: string): URL | null {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** `true` when `url` is http(s) on one of `hosts` or a subdomain of one. */
  private hostIn(url: string | URL, hosts: readonly string[]): boolean {
    const parsed = typeof url === 'string' ? this.parseHttpUrl(url) : url;
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  /** Strip tracking params; LinkedIn keeps `origin + pathname` only. */
  private cleanUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.hostname.includes('linkedin.com')) return u.origin + u.pathname;
      return u.origin + u.pathname + u.search;
    } catch {
      return url;
    }
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.split(String.fromCharCode(160)).join(' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Runs in the Airtable form page. Form-name heading + description block:
 * try dedicated description containers first, then the longest paragraph
 * near the form header.
 */
const AIRTABLE_DESCRIPTION_JS = `(() => {
  const pick = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const selectors = [
    '.formDescription',
    '[class*="formDescription"]',
    '[class*="form-description"]',
    '[data-testid*="description" i]',
    '[class*="sharedForm"] [class*="description" i]',
    'h1 + p',
    'h1 ~ p',
    'header p',
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      const t = pick(el);
      if (t && t.length >= 20) return t;
    } catch (_) { /* invalid selector for this engine */ }
  }
  let best = '';
  const candidates = document.querySelectorAll('p, [class*="description" i], [class*="Description"]');
  for (const el of Array.from(candidates)) {
    const t = pick(el);
    if (t.length > best.length && t.length <= 4000) best = t;
  }
  return best || null;
})()`;
