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
  extractJobType,
  parseLocationText,
  pinUrlToHosts,
} from '@ever-jobs/common';
import {
  FOUR_EARTH_TECH_ALLOWED_HOSTS,
  FOUR_EARTH_TECH_CAREERS_URL,
  FOUR_EARTH_TECH_CHUNK_RE,
  FOUR_EARTH_TECH_COMPANY_NAME,
  FOUR_EARTH_TECH_DEFAULT_TIMEOUT_SECONDS,
  FOUR_EARTH_TECH_JOBS_ARRAY_RE,
  FOUR_EARTH_TECH_MAX_LITERAL_CHARS,
  FOUR_EARTH_TECH_ORIGIN,
} from './four-earth-tech.constants';
import { FourEarthJobEntry, FourEarthJobSection } from './four-earth-tech.types';

@SourcePlugin({
  site: Site.FOUR_EARTH_TECH,
  name: FOUR_EARTH_TECH_COMPANY_NAME,
  category: 'company',
  companyDomains: ['4earth.tech'],
})
@Injectable()
export class FourEarthTechService implements IScraper {
  private readonly logger = new Logger(FourEarthTechService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job entries found in the 4Earth careers chunk'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`4Earth: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`4Earth scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? FOUR_EARTH_TECH_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: FOUR_EARTH_TECH_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const shellRes = await client.get<string>(careersUrl);
    const chunkUrl = this.chunkUrl(String(shellRes.data ?? ''));
    if (!chunkUrl) return [];

    const chunkRes = await client.get<string>(chunkUrl);
    const entries = this.parseJobsArray(String(chunkRes.data ?? ''));
    return entries
      .map((entry) => this.toJobPost(entry, careersUrl))
      .filter((job): job is JobPostDto => job !== null);
  }

  /**
   * The careers page to fetch: the caller's `companyUrl` when it is on
   * 4earth.tech (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return FOUR_EARTH_TECH_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, FOUR_EARTH_TECH_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `4Earth: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${FOUR_EARTH_TECH_ALLOWED_HOSTS.join(', ')}`,
      );
      return FOUR_EARTH_TECH_CAREERS_URL;
    }
    return pinned;
  }

  /** `/assets/Careers-{hash}.js` referenced by the careers shell. */
  private chunkUrl(shellHtml: string): string | null {
    const m = FOUR_EARTH_TECH_CHUNK_RE.exec(shellHtml);
    if (!m) return null;
    return `${FOUR_EARTH_TECH_ORIGIN}${m[1]}`;
  }

  /**
   * The chunk's jobs array is a minified JS literal bound to a name that
   * changes per build — anchored on `=[{id:"` and sliced by balanced
   * brackets, never evaluated.
   */
  private parseJobsArray(src: string): FourEarthJobEntry[] {
    const m = FOUR_EARTH_TECH_JOBS_ARRAY_RE.exec(src);
    if (!m) return [];
    const openIdx = src.indexOf('[', m.index);
    const arrayText = this.balancedSlice(src, openIdx);
    if (!arrayText) return [];
    return this.splitTopLevel(arrayText.slice(1, -1))
      .filter((seg) => seg.startsWith('{'))
      .map((seg) => this.parseEntry(seg))
      .filter((entry): entry is FourEarthJobEntry => entry !== null);
  }

  private parseEntry(objText: string): FourEarthJobEntry | null {
    const id = this.scalarField(objText, 'id');
    const title = this.scalarField(objText, 'title');
    if (!id || !title) return null;
    return {
      id,
      title,
      location: this.scalarField(objText, 'location') ?? '',
      type: this.scalarField(objText, 'type') ?? '',
      mission: this.scalarField(objText, 'mission') ?? '',
      roleIntro: this.scalarField(objText, 'roleIntro') ?? '',
      roleSummary: this.scalarField(objText, 'roleSummary') ?? '',
      rolePoints: this.arrayField(objText, 'rolePoints').map((seg) => this.stripQuotes(seg)),
      sections: this.arrayField(objText, 'sections')
        .filter((seg) => seg.startsWith('{'))
        .map((seg) => this.parseSection(seg)),
      whySection: this.scalarField(objText, 'whySection') ?? '',
    };
  }

  private parseSection(objText: string): FourEarthJobSection {
    return {
      heading: this.scalarField(objText, 'heading') ?? '',
      items: this.arrayField(objText, 'items').map((seg) => {
        if (seg.startsWith('{')) {
          return {
            label: this.scalarField(seg, 'label') ?? undefined,
            text: this.scalarField(seg, 'text') ?? '',
          };
        }
        return { text: this.stripQuotes(seg) };
      }),
    };
  }

  /**
   * Slice from the opening bracket at `openIdx` through its match,
   * skipping over string literals (single/double quotes + escapes).
   * Returns the bracket-inclusive text, or null when unbalanced or longer
   * than {@link FOUR_EARTH_TECH_MAX_LITERAL_CHARS} (Spec 1689 size cap).
   */
  private balancedSlice(src: string, openIdx: number): string | null {
    let depth = 0;
    let quote: string | null = null;
    const end = Math.min(src.length, openIdx + FOUR_EARTH_TECH_MAX_LITERAL_CHARS);
    for (let i = openIdx; i < end; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return src.slice(openIdx, i + 1);
      }
    }
    return null;
  }

  /** Split `a,b,c` at top-level commas, respecting strings and brackets. */
  private splitTopLevel(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    const tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  /**
   * `key: "…"` or `key: '…'` inside an object literal; unescaped value or null.
   *
   * The two body alternatives are disjoint (Spec 1689): an escape starts with
   * a backslash, a plain character never is one. The fork's
   * `(?:\\.|(?:(?!\1).))*` let a backslash match either branch, so a run of
   * backslashes before a line break backtracked exponentially (64 of them
   * would pin the event loop for hours). A plain character still excludes
   * line terminators, exactly as `.` did.
   */
  private scalarField(objText: string, key: string): string | null {
    const re = new RegExp(
      `\\b${key}\\s*:\\s*(["'])((?:\\\\.|(?!\\1)[^\\\\\\n\\r\\u2028\\u2029])*)\\1`,
    );
    const m = re.exec(objText);
    return m ? this.unescapeJs(m[2]) : null;
  }

  /** `key: […]` inside an object literal; top-level segments of the array. */
  private arrayField(objText: string, key: string): string[] {
    const re = new RegExp(`\\b${key}\\s*:\\s*\\[`);
    const m = re.exec(objText);
    if (!m) return [];
    const openIdx = objText.indexOf('[', m.index);
    const sliced = this.balancedSlice(objText, openIdx);
    if (!sliced) return [];
    return this.splitTopLevel(sliced.slice(1, -1));
  }

  /** Strip a surrounding quote pair and unescape the interior. */
  private stripQuotes(seg: string): string {
    const s = seg.trim();
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) {
      return this.unescapeJs(s.slice(1, -1));
    }
    return s;
  }

  /** Decode the escapes a bundler emits inside JS string literals. */
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

  private toJobPost(entry: FourEarthJobEntry, careersUrl: string): JobPostDto | null {
    const parsed = entry.location ? parseLocationText(entry.location) : null;
    const location = parsed?.location ?? null;
    const jobType = entry.type ? extractJobType(entry.type.replace(/-/g, ' ')) : null;
    const description = this.composeDescription(entry);

    return new JobPostDto({
      id: `4earth_tech-${entry.id}`,
      atsId: entry.id,
      site: Site.FOUR_EARTH_TECH,
      atsType: '4earth_tech',
      title: entry.title,
      companyName: FOUR_EARTH_TECH_COMPANY_NAME,
      companyUrl: FOUR_EARTH_TECH_ORIGIN,
      jobUrl: careersUrl,
      jobUrlDirect: careersUrl,
      applyUrl: careersUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(description ? { description } : {}),
      jobType: jobType ?? null,
      ...(entry.type ? { employmentType: entry.type } : {}),
    });
  }

  private composeDescription(entry: FourEarthJobEntry): string {
    const parts: string[] = [];
    if (entry.mission) parts.push(entry.mission);
    if (entry.roleIntro) parts.push(entry.roleIntro);
    if (entry.roleSummary) parts.push(entry.roleSummary);
    if (entry.rolePoints.length) {
      parts.push(entry.rolePoints.map((p) => `- ${p}`).join('\n'));
    }
    for (const section of entry.sections) {
      const lines = section.items.map((item) =>
        item.label ? `- ${item.label}: ${item.text}` : `- ${item.text}`,
      );
      parts.push([section.heading ? `${section.heading}:` : '', ...lines].join('\n').trim());
    }
    if (entry.whySection) parts.push(entry.whySection);
    return parts.filter(Boolean).join('\n\n');
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
