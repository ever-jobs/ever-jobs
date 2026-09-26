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
  LABS_ACTOR_ALLOWED_HOSTS,
  LABS_ACTOR_APPLY_DEFAULT_EMAIL,
  LABS_ACTOR_APPLY_LANE_EMAIL,
  LABS_ACTOR_APPLY_LANE_TEAMS,
  LABS_ACTOR_CAREERS_URL,
  LABS_ACTOR_CHUNK_MAP_RE,
  LABS_ACTOR_CHUNK_PAIR_RE,
  LABS_ACTOR_COMPANY_NAME,
  LABS_ACTOR_DEFAULT_TIMEOUT_SECONDS,
  LABS_ACTOR_JOBS_ARRAY_RE,
  LABS_ACTOR_MAIN_JS_RE,
  LABS_ACTOR_MAX_CHUNKS,
  LABS_ACTOR_MAX_LITERAL_CHARS,
  LABS_ACTOR_ORIGIN,
} from './labs-actor.constants';
import { LabsActorJobEntry } from './labs-actor.types';

@SourcePlugin({
  site: Site.LABS_ACTOR,
  name: LABS_ACTOR_COMPANY_NAME,
  category: 'company',
  companyDomains: ['labs.actor'],
})
@Injectable()
export class LabsActorService implements IScraper {
  private readonly logger = new Logger(LabsActorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job entries found in the Actor hiring chunk'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Actor: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Actor scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? LABS_ACTOR_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: LABS_ACTOR_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const shellRes = await client.get<string>(careersUrl);
    const mainPath = LABS_ACTOR_MAIN_JS_RE.exec(String(shellRes.data ?? ''))?.[1];
    if (!mainPath) return [];

    const mainRes = await client.get<string>(`${LABS_ACTOR_ORIGIN}${mainPath}`);
    const chunkUrls = this.chunkUrls(String(mainRes.data ?? ''));
    for (const chunkUrl of chunkUrls.slice(0, LABS_ACTOR_MAX_CHUNKS)) {
      const chunkRes = await client.get<string>(chunkUrl).catch(() => null);
      const src = String(chunkRes?.data ?? '');
      if (!LABS_ACTOR_JOBS_ARRAY_RE.test(src)) continue;
      const jobs = this.parseJobsArray(src)
        .map((entry) => this.toJobPost(entry, careersUrl))
        .filter((job): job is JobPostDto => job !== null);
      if (jobs.length) return jobs;
    }
    return [];
  }

  /**
   * The careers page to fetch: the caller's `companyUrl` when it is on
   * labs.actor (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-rdw` does: a company plugin
   * scrapes one company, so an off-domain, internal or malformed `companyUrl`
   * is a mistake or an attempt to aim our HTTP client elsewhere. Neither
   * deserves a failed scrape — ignore it and say so. `http:` is upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return LABS_ACTOR_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, LABS_ACTOR_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Actor: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${LABS_ACTOR_ALLOWED_HOSTS.join(', ')}`,
      );
      return LABS_ACTOR_CAREERS_URL;
    }
    return pinned;
  }

  /**
   * `/static/js/{id}.{hash}.chunk.js` URLs from the main bundle's webpack
   * runtime chunk map (`{115:"bae9c619",…}[e]+".chunk.js"`). The map is
   * resolved at fetch time — hashes rotate on every deploy.
   */
  private chunkUrls(mainJs: string): string[] {
    const m = LABS_ACTOR_CHUNK_MAP_RE.exec(mainJs);
    if (!m) return [];
    const urls: string[] = [];
    for (const pair of m[1].matchAll(LABS_ACTOR_CHUNK_PAIR_RE)) {
      urls.push(`${LABS_ACTOR_ORIGIN}/static/js/${pair[1]}.${pair[2]}.chunk.js`);
    }
    return urls;
  }

  /**
   * The chunk's jobs array is a minified JS literal bound to a name that
   * changes per build — anchored on `=[{id:"` and sliced by balanced
   * brackets, never evaluated.
   */
  private parseJobsArray(src: string): LabsActorJobEntry[] {
    const m = LABS_ACTOR_JOBS_ARRAY_RE.exec(src);
    if (!m) return [];
    const openIdx = src.indexOf('[', m.index);
    const arrayText = this.balancedSlice(src, openIdx);
    if (!arrayText) return [];
    return this.splitTopLevel(arrayText.slice(1, -1))
      .filter((seg) => seg.startsWith('{'))
      .map((seg) => this.parseEntry(seg))
      .filter((entry): entry is LabsActorJobEntry => entry !== null);
  }

  private parseEntry(objText: string): LabsActorJobEntry | null {
    const id = this.scalarField(objText, 'id');
    const title = this.scalarField(objText, 'title');
    if (!id || !title) return null;
    return {
      id,
      title,
      team: this.scalarField(objText, 'team') ?? '',
      location: this.scalarField(objText, 'location') ?? '',
      type: this.scalarField(objText, 'type') ?? '',
      summary: this.scalarField(objText, 'summary') ?? '',
      responsibilities: this.arrayField(objText, 'responsibilities').map((seg) =>
        this.stripQuotes(seg),
      ),
      requirements: this.arrayField(objText, 'requirements').map((seg) =>
        this.stripQuotes(seg),
      ),
    };
  }

  /**
   * Slice from the opening bracket at `openIdx` through its match,
   * skipping over string literals (single/double quotes + escapes).
   * Returns the bracket-inclusive text, or null when unbalanced or longer
   * than {@link LABS_ACTOR_MAX_LITERAL_CHARS} (Spec 1689 size cap).
   */
  private balancedSlice(src: string, openIdx: number): string | null {
    let depth = 0;
    let quote: string | null = null;
    const end = Math.min(src.length, openIdx + LABS_ACTOR_MAX_LITERAL_CHARS);
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
   * backslashes before a line break backtracked exponentially. A plain
   * character still excludes line terminators, exactly as `.` did.
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
    return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_m, esc: string) => {
      if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16));
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

  private toJobPost(entry: LabsActorJobEntry, careersUrl: string): JobPostDto | null {
    const parsed = entry.location
      ? parseLocationText(this.locationBeforeDot(entry.location))
      : null;
    const location = parsed?.location ?? null;
    const jobType = entry.type ? extractJobType(entry.type.replace(/-/g, ' ')) : null;
    const description = this.composeDescription(entry);

    return new JobPostDto({
      id: `labs_actor-${entry.id}`,
      atsId: entry.id,
      site: Site.LABS_ACTOR,
      atsType: 'labs_actor',
      title: entry.title,
      companyName: LABS_ACTOR_COMPANY_NAME,
      companyUrl: LABS_ACTOR_ORIGIN,
      jobUrl: careersUrl,
      jobUrlDirect: careersUrl,
      applyUrl: this.applyMailto(entry),
      location,
      ...(location ? { locations: [location] } : {}),
      ...(entry.team ? { department: entry.team } : {}),
      ...(description ? { description } : {}),
      jobType: jobType ?? null,
      ...(entry.type ? { employmentType: entry.type } : {}),
    });
  }

  /**
   * `"Los Angeles, CA · Onsite"` → `"Los Angeles, CA"`. Same result as the
   * fork's `replace(/\s*·.*$/, '')` without its unanchored `\s*`, which was
   * quadratic on a long whitespace run (Spec 1689). As before, the cut is at
   * the first `·` with no line break after it (`.` stops at one).
   */
  private locationBeforeDot(location: string): string {
    const lastBreak = Math.max(
      location.lastIndexOf('\n'),
      location.lastIndexOf('\r'),
      location.lastIndexOf(' '),
      location.lastIndexOf(' '),
    );
    const dot = location.indexOf('·', lastBreak + 1);
    return dot < 0 ? location : location.slice(0, dot).trimEnd();
  }

  /** The site's own apply CTA: a per-role mailto whose mailbox is team-routed. */
  private applyMailto(entry: LabsActorJobEntry): string {
    const email = LABS_ACTOR_APPLY_LANE_TEAMS.has(entry.team.toLowerCase())
      ? LABS_ACTOR_APPLY_LANE_EMAIL
      : LABS_ACTOR_APPLY_DEFAULT_EMAIL;
    return `mailto:${email}?subject=${encodeURIComponent(`${entry.title} — application`)}`;
  }

  private composeDescription(entry: LabsActorJobEntry): string {
    const parts: string[] = [];
    if (entry.summary) parts.push(entry.summary);
    if (entry.responsibilities.length) {
      parts.push(
        ['What you will do:', ...entry.responsibilities.map((p) => `- ${p}`)].join('\n'),
      );
    }
    if (entry.requirements.length) {
      parts.push(
        ['What we are looking for:', ...entry.requirements.map((p) => `- ${p}`)].join('\n'),
      );
    }
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
