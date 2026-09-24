import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  getJobTypeFromString,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, describeUrlForLog, parseLocationText, pinUrlToHosts } from '@ever-jobs/common';
import {
  TAU_ROBOTICS_ALLOWED_HOSTS,
  TAU_ROBOTICS_APPLY_JS_URL,
  TAU_ROBOTICS_CAREERS_URL,
  TAU_ROBOTICS_COMPANY_NAME,
  TAU_ROBOTICS_DEFAULT_TIMEOUT_SECONDS,
  TAU_ROBOTICS_MAX_LITERAL_CHARS,
  TAU_ROBOTICS_ORIGIN,
  TAU_ROBOTICS_SKIP_SLUGS,
} from './tau-robotics.constants';
import { TauRoleDef } from './tau-robotics.types';

interface CareersAnchor {
  slug: string;
  title: string;
  meta: string;
  jobUrl: string;
}

@SourcePlugin({
  site: Site.TAU_ROBOTICS,
  name: 'Tau Robotics',
  category: 'company',
  companyDomains: ['tau-robotics.com'],
})
@Injectable()
export class TauRoboticsService implements IScraper {
  private readonly logger = new Logger(TauRoboticsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      const out = this.applyInput(jobs, input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no role anchors found on the Tau Robotics careers page'),
        );
      }
      this.logger.log(`Tau Robotics: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Tau Robotics scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? TAU_ROBOTICS_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: TAU_ROBOTICS_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const careersRes = await client.get<string>(careersUrl);
    const anchors = this.parseCareersPage(cheerio.load(careersRes.data));
    if (anchors.length === 0) return [];

    const roles = await this.fetchRolesMap(client);
    return anchors.map((anchor) => this.toJobPost(anchor, roles.get(anchor.slug)));
  }

  /**
   * The careers page to fetch: the caller's `companyUrl` when it is on
   * tau-robotics.com (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return TAU_ROBOTICS_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, TAU_ROBOTICS_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Tau Robotics: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${TAU_ROBOTICS_ALLOWED_HOSTS.join(', ')}`,
      );
      return TAU_ROBOTICS_CAREERS_URL;
    }
    return pinned;
  }

  private parseCareersPage($: cheerio.CheerioAPI): CareersAnchor[] {
    const anchors: CareersAnchor[] = [];
    $('a[href*="apply.html?role="], a[href*="apply?role="]').each((_: number, el: any) => {
      const $a = $(el);
      const href = $a.attr('href') ?? '';
      const slug = this.slugFromHref(href);
      if (!slug || TAU_ROBOTICS_SKIP_SLUGS.has(slug)) return;
      anchors.push({
        slug,
        title: this.normalize($a.find('.role__title').first().text()),
        meta: this.normalize($a.find('.role__meta').first().text()),
        jobUrl: new URL(href, TAU_ROBOTICS_ORIGIN).toString(),
      });
    });
    return anchors;
  }

  private slugFromHref(href: string): string {
    const match = /[?&]role=([a-z0-9-]+)/i.exec(href);
    return match ? match[1] : '';
  }

  private async fetchRolesMap(client: {
    get<T>(url: string): Promise<{ data: T }>;
  }): Promise<Map<string, TauRoleDef>> {
    try {
      const res = await client.get<string>(TAU_ROBOTICS_APPLY_JS_URL);
      return this.parseRolesLiteral(res.data);
    } catch (error: unknown) {
      this.logger.warn(
        `apply.js unavailable — descriptions will be absent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }

  /**
   * Extract the `const ROLES = { ... };` object literal from apply.js by
   * balanced-brace slicing, then parse each `'slug': { ... }` entry.
   * Never evals — the literal is single-quoted JS, not JSON.
   */
  private parseRolesLiteral(js: string): Map<string, TauRoleDef> {
    const map = new Map<string, TauRoleDef>();
    const decl = /\bROLES\s*=\s*\{/.exec(js);
    if (!decl) return map;
    const braceStart = js.indexOf('{', decl.index);

    const body = this.sliceBalanced(js, braceStart!);
    if (!body) return map;

    const entryRe = /'([a-z0-9-]+)'\s*:\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(body)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const entry = this.sliceBalanced(body, openIdx);
      if (!entry) continue;
      map.set(m[1], this.parseRoleDef(entry));
      // Resume after this entry: re-scanning inside it made nested
      // `'x': {` shapes quadratic (Spec 1689).
      entryRe.lastIndex = openIdx + entry.length;
    }
    return map;
  }

  /**
   * Slice from the `{` at `openIdx` through its matching `}`; `''` when
   * unbalanced or longer than {@link TAU_ROBOTICS_MAX_LITERAL_CHARS}.
   */
  private sliceBalanced(text: string, openIdx: number): string {
    let depth = 0;
    let inString = false;
    const end = Math.min(text.length, openIdx + TAU_ROBOTICS_MAX_LITERAL_CHARS);
    for (let i = openIdx; i < end; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++; // skip escaped char
        else if (c === "'") inString = false;
        continue;
      }
      if (c === "'") inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(openIdx, i + 1);
      }
    }
    return '';
  }

  private parseRoleDef(literal: string): TauRoleDef {
    return {
      title: this.literalString(literal, 'title'),
      meta: this.literalString(literal, 'meta'),
      responsibilities: this.literalArray(literal, 'responsibilities'),
      requirements: this.literalArray(literal, 'requirements'),
    };
  }

  private literalString(literal: string, key: string): string | undefined {
    const m = new RegExp(`${key}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`).exec(literal);
    return m ? this.unescape(m[1]) : undefined;
  }

  /**
   * `key: [ … ]` inside a role literal; the array's string items, or
   * `undefined` when there is no balanced array for `key`.
   *
   * Spec 1689: the fork matched the array with
   * `\[((?:[^\[\]]|'(?:\\.|[^'\\])*')*)\]`, whose alternatives overlap (`'`
   * also matches `[^\[\]]`), so an array with no reachable `]` — e.g. one
   * double-quoted item containing `[` — backtracked exponentially (22 items
   * took 42 s). The array is now sliced by a single linear scan that skips
   * both quote styles, capped at {@link TAU_ROBOTICS_MAX_LITERAL_CHARS}.
   */
  private literalArray(literal: string, key: string): string[] | undefined {
    const m = new RegExp(`${key}\\s*:\\s*\\[`).exec(literal);
    if (!m) return undefined;
    // One attempt only: retrying at every later `key: [` would make an
    // unbalanced tail quadratic.
    const body = this.sliceBracketed(literal, m.index + m[0].length - 1);
    return body === null ? undefined : this.quotedItems(body);
  }

  /**
   * The text between the `[` at `openIdx` and its matching `]`, skipping
   * single- and double-quoted strings (with escapes); `null` when unbalanced
   * or longer than {@link TAU_ROBOTICS_MAX_LITERAL_CHARS}.
   */
  private sliceBracketed(text: string, openIdx: number): string | null {
    let depth = 0;
    let quote: string | null = null;
    const end = Math.min(text.length, openIdx + TAU_ROBOTICS_MAX_LITERAL_CHARS);
    for (let i = openIdx; i < end; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') quote = c;
      else if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return text.slice(openIdx + 1, i);
      }
    }
    return null;
  }

  /** Every single- or double-quoted string literal in `body`, unescaped, in order. */
  private quotedItems(body: string): string[] {
    const items: string[] = [];
    for (let i = 0; i < body.length; i++) {
      const quote = body[i];
      if (quote !== "'" && quote !== '"') continue;
      let j = i + 1;
      while (j < body.length && body[j] !== quote) {
        j += body[j] === '\\' ? 2 : 1;
      }
      if (j >= body.length) break;
      items.push(this.unescape(body.slice(i + 1, j)));
      i = j;
    }
    return items;
  }

  private unescape(value: string): string {
    return value.replace(/\\(.)/g, '$1');
  }

  private toJobPost(anchor: CareersAnchor, role?: TauRoleDef): JobPostDto {
    const metaParts = anchor.meta.split('·').map((part) => this.normalize(part));
    const [department, locationText, typeText] = metaParts;
    const parsed = locationText ? parseLocationText(locationText) : null;
    const location = parsed?.location ?? null;
    const jobType = typeText ? getJobTypeFromString(typeText) : null;
    const description = role ? this.buildDescription(role) : undefined;

    return new JobPostDto({
      id: `tau-robotics-${anchor.slug}`,
      atsId: anchor.slug,
      site: Site.TAU_ROBOTICS,
      atsType: 'tau-robotics',
      title: role?.title ?? anchor.title,
      companyName: TAU_ROBOTICS_COMPANY_NAME,
      companyUrl: TAU_ROBOTICS_ORIGIN,
      jobUrl: anchor.jobUrl,
      jobUrlDirect: anchor.jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(department ? { department } : {}),
      jobType: jobType ? [jobType] : null,
      ...(typeText ? { employmentType: typeText } : {}),
      ...(description ? { description } : {}),
    });
  }

  private buildDescription(role: TauRoleDef): string {
    const sections: string[] = [];
    if (role.responsibilities?.length) {
      sections.push(`Responsibilities:\n${role.responsibilities.map((r) => `- ${r}`).join('\n')}`);
    }
    if (role.requirements?.length) {
      sections.push(`Requirements:\n${role.requirements.map((r) => `- ${r}`).join('\n')}`);
    }
    return sections.join('\n\n');
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
