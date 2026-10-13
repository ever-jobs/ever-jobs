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
import { createHttpClient, extractJobType, parseLocationText } from '@ever-jobs/common';
import {
  THORON_US_CAREERS_URL,
  THORON_US_COMPANY_NAME,
  THORON_US_DEFAULT_TIMEOUT_SECONDS,
  THORON_US_JOBS_ARRAY_RE,
  THORON_US_MAIN_JS_RE,
  THORON_US_ORIGIN,
} from './thoron-us.constants';
import { ThoronJobEntry } from './thoron-us.types';

@SourcePlugin({
  site: Site.THORON_US,
  name: THORON_US_COMPANY_NAME,
  category: 'company',
  companyDomains: ['thoron.us'],
})
@Injectable()
export class ThoronUsService implements IScraper {
  private readonly logger = new Logger(ThoronUsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job entries found in the Thoron bundle'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Thoron: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Thoron scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? THORON_US_DEFAULT_TIMEOUT_SECONDS,
    });

    const careersUrl = this.normalize(input.companyUrl) || THORON_US_CAREERS_URL;
    const shellRes = await client.get<string>(careersUrl);
    const mainPath = THORON_US_MAIN_JS_RE.exec(String(shellRes.data ?? ''))?.[1];
    if (!mainPath) return [];

    const bundleRes = await client.get<string>(`${THORON_US_ORIGIN}${mainPath}`);
    return this.parseJobsArray(String(bundleRes.data ?? ''))
      .map((entry) => this.toJobPost(entry))
      .filter((job): job is JobPostDto => job !== null);
  }

  /**
   * The jobs array is a minified JS literal bound to a name that changes
   * per build — anchored on the full `{id:N,title,department,location,type}`
   * entry run and sliced by balanced brackets, never evaluated.
   */
  private parseJobsArray(src: string): ThoronJobEntry[] {
    const m = THORON_US_JOBS_ARRAY_RE.exec(src);
    if (!m) return [];
    const openIdx = src.indexOf('[', m.index);
    const arrayText = this.balancedSlice(src, openIdx);
    if (!arrayText) return [];
    return this.splitTopLevel(arrayText.slice(1, -1))
      .filter((seg) => seg.startsWith('{'))
      .map((seg) => this.parseEntry(seg))
      .filter((entry): entry is ThoronJobEntry => entry !== null);
  }

  private parseEntry(objText: string): ThoronJobEntry | null {
    const id = this.numericField(objText, 'id');
    const title = this.scalarField(objText, 'title');
    if (!id || !title) return null;
    return {
      id,
      title,
      department: this.scalarField(objText, 'department') ?? '',
      location: this.scalarField(objText, 'location') ?? '',
      type: this.scalarField(objText, 'type') ?? '',
      whatYoullDo: this.arrayField(objText, 'whatYoullDo').map((seg) =>
        this.stripQuotes(seg),
      ),
      whatYouBring: this.arrayField(objText, 'whatYouBring').map((seg) =>
        this.stripQuotes(seg),
      ),
      niceToHaves: this.arrayField(objText, 'niceToHaves').map((seg) =>
        this.stripQuotes(seg),
      ),
    };
  }

  /**
   * Slice from the opening bracket at `openIdx` through its match,
   * skipping over string literals (single/double quotes + escapes).
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

  /** `key: "…"` or `key: '…'` inside an object literal; unescaped value or null. */
  private scalarField(objText: string, key: string): string | null {
    const re = new RegExp(`\\b${key}\\s*:\\s*(["'])((?:\\\\.|(?:(?!\\1).))*)\\1`);
    const m = re.exec(objText);
    return m ? this.unescapeJs(m[2]) : null;
  }

  /** `key: 123` inside an object literal; the digits as a string or null. */
  private numericField(objText: string, key: string): string | null {
    const re = new RegExp(`\\b${key}\\s*:\\s*(\\d+)`);
    const m = re.exec(objText);
    return m ? m[1] : null;
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

  private toJobPost(entry: ThoronJobEntry): JobPostDto {
    const parsed = entry.location ? parseLocationText(entry.location) : null;
    const location = parsed?.location ?? null;
    const jobType = entry.type ? extractJobType(entry.type.replace(/-/g, ' ')) : null;
    const description = this.composeDescription(entry);

    return new JobPostDto({
      id: `thoron_us-${entry.id}`,
      atsId: entry.id,
      site: Site.THORON_US,
      atsType: 'thoron_us',
      title: entry.title,
      companyName: THORON_US_COMPANY_NAME,
      companyUrl: THORON_US_ORIGIN,
      jobUrl: THORON_US_CAREERS_URL,
      jobUrlDirect: THORON_US_CAREERS_URL,
      applyUrl: THORON_US_CAREERS_URL,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(entry.department ? { department: entry.department } : {}),
      ...(description ? { description } : {}),
      jobType: jobType ?? null,
      ...(entry.type ? { employmentType: entry.type } : {}),
    });
  }

  private composeDescription(entry: ThoronJobEntry): string {
    const parts: string[] = [];
    if (entry.whatYoullDo.length) {
      parts.push(
        ["What you'll do:", ...entry.whatYoullDo.map((p) => `- ${p}`)].join('\n'),
      );
    }
    if (entry.whatYouBring.length) {
      parts.push(
        ['What you bring:', ...entry.whatYouBring.map((p) => `- ${p}`)].join('\n'),
      );
    }
    if (entry.niceToHaves.length) {
      parts.push(
        ['Nice to have:', ...entry.niceToHaves.map((p) => `- ${p}`)].join('\n'),
      );
    }
    return parts.filter(Boolean).join('\n\n');
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.department, job.description].some((value) =>
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
