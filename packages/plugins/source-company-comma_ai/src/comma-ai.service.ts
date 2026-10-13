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
import { createHttpClient, parseLocationText } from '@ever-jobs/common';
import {
  COMMA_AI_CAREERS_URL,
  COMMA_AI_COMPANY_NAME,
  COMMA_AI_DEFAULT_TIMEOUT_SECONDS,
  COMMA_AI_JOBS_ARRAY_RE,
  COMMA_AI_MAX_CHUNKS,
  COMMA_AI_NODE_CHUNK_RE,
  COMMA_AI_ONSITE_PREFIX_RE,
  COMMA_AI_ORIGIN,
  COMMA_AI_QUALIFICATIONS_RE,
} from './comma-ai.constants';
import { CommaAiJobEntry } from './comma-ai.types';

@SourcePlugin({
  site: Site.COMMA_AI,
  name: COMMA_AI_COMPANY_NAME,
  category: 'company',
  companyDomains: ['comma.ai'],
})
@Injectable()
export class CommaAiService implements IScraper {
  private readonly logger = new Logger(CommaAiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job entries found in the comma.ai jobs chunk'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`comma.ai: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`comma.ai scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? COMMA_AI_DEFAULT_TIMEOUT_SECONDS,
    });

    const careersUrl = this.normalize(input.companyUrl) || COMMA_AI_CAREERS_URL;
    const shellRes = await client.get<string>(careersUrl);
    for (const chunkPath of this.chunkPaths(String(shellRes.data ?? ''))) {
      const chunkRes = await client
        .get<string>(`${COMMA_AI_ORIGIN}${chunkPath}`)
        .catch(() => null);
      const src = String(chunkRes?.data ?? '');
      if (!COMMA_AI_QUALIFICATIONS_RE.test(src)) continue;
      const jobs = this.parseJobsArray(src)
        .map((entry) => this.toJobPost(entry, careersUrl))
        .filter((job): job is JobPostDto => job !== null);
      if (jobs.length) return jobs;
    }
    return [];
  }

  /** Unique `/_app/immutable/nodes/*.js` paths embedded in the careers page. */
  private chunkPaths(html: string): string[] {
    const paths: string[] = [];
    for (const m of html.matchAll(COMMA_AI_NODE_CHUNK_RE)) {
      if (!paths.includes(m[1])) paths.push(m[1]);
      if (paths.length >= COMMA_AI_MAX_CHUNKS) break;
    }
    return paths;
  }

  /**
   * The chunk's jobs array is a minified JS literal bound to a name that
   * changes per build — anchored on `=[{title:"` and sliced by balanced
   * brackets, never evaluated. `description` is a backtick template literal.
   */
  private parseJobsArray(src: string): CommaAiJobEntry[] {
    const m = COMMA_AI_JOBS_ARRAY_RE.exec(src);
    if (!m) return [];
    const openIdx = src.indexOf('[', m.index);
    const arrayText = this.balancedSlice(src, openIdx);
    if (!arrayText) return [];
    return this.splitTopLevel(arrayText.slice(1, -1))
      .filter((seg) => seg.startsWith('{'))
      .map((seg) => this.parseEntry(seg))
      .filter((entry): entry is CommaAiJobEntry => entry !== null);
  }

  private parseEntry(objText: string): CommaAiJobEntry | null {
    const title = this.scalarField(objText, 'title');
    const description = this.templateField(objText, 'description');
    if (!title || !description) return null;
    return {
      title,
      team: this.scalarField(objText, 'team') ?? '',
      location: this.scalarField(objText, 'location') ?? '',
      description,
      qualifications: this.arrayField(objText, 'qualifications').map((seg) =>
        this.stripQuotes(seg),
      ),
      howToApply: this.scalarField(objText, 'howToApply') ?? '',
    };
  }

  private toJobPost(entry: CommaAiJobEntry, careersUrl: string): JobPostDto | null {
    const slug = this.slugify(entry.title);
    if (!slug) return null;
    const parsed = entry.location
      ? parseLocationText(entry.location.replace(COMMA_AI_ONSITE_PREFIX_RE, ''))
      : null;
    const location = parsed?.location ?? null;
    const jobUrl = `${careersUrl}#${slug}`;
    const description = this.composeDescription(entry);

    return new JobPostDto({
      id: `comma_ai-${slug}`,
      atsId: slug,
      site: Site.COMMA_AI,
      atsType: 'comma_ai',
      title: entry.title,
      companyName: COMMA_AI_COMPANY_NAME,
      companyUrl: COMMA_AI_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      applyUrl: jobUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(entry.team ? { department: entry.team } : {}),
      ...(description ? { description } : {}),
      jobType: null,
    });
  }

  private composeDescription(entry: CommaAiJobEntry): string {
    const parts: string[] = [];
    if (entry.description) parts.push(entry.description.trim());
    if (entry.qualifications.length) {
      parts.push(
        ['Qualifications:', ...entry.qualifications.map((p) => `- ${p}`)].join('\n'),
      );
    }
    if (entry.howToApply) parts.push(entry.howToApply.trim());
    return parts.filter(Boolean).join('\n\n');
  }

  /** The site's own anchor ids are the kebab-case of the title. */
  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Slice from the opening bracket at `openIdx` through its match,
   * skipping over string literals (single/double/backtick + escapes).
   * Returns the bracket-inclusive text, or null when unbalanced.
   */
  private balancedSlice(src: string, openIdx: number): string | null {
    let depth = 0;
    let quote: string | null = null;
    for (let i = openIdx; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
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
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
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

  /** `key: "…"` or `key: '…'` inside an object literal; unescaped value or null. */
  private scalarField(objText: string, key: string): string | null {
    const re = new RegExp(`\\b${key}\\s*:\\s*(["'])((?:\\\\.|(?:(?!\\1).))*)\\1`);
    const m = re.exec(objText);
    return m ? this.unescapeJs(m[2]) : null;
  }

  /** `key: \`…\`` inside an object literal — a template-literal field. */
  private templateField(objText: string, key: string): string | null {
    const re = new RegExp(`\\b${key}\\s*:\\s*\`((?:\\\\.|[^\`])*)\``);
    const m = re.exec(objText);
    return m ? this.unescapeJs(m[1]) : null;
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
    if ((q === '"' || q === "'" || q === '`') && s[s.length - 1] === q) {
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
        default: return esc; // \" \' \\ \/ \` etc.
      }
    });
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
