import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import { classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, parseLocationList } from '@ever-jobs/common';
import {
  GALADYNE_IO_CAREERS_URL,
  GALADYNE_IO_CHUNK_HREF_RE,
  GALADYNE_IO_COMPANY_NAME,
  GALADYNE_IO_DEFAULT_RESULTS,
  GALADYNE_IO_DEFAULT_TIMEOUT_SECONDS,
  GALADYNE_IO_ORIGIN,
} from './galadyne_io.constants';
import { GaladyneIoCard, GaladyneIoContent } from './galadyne_io.types';

@SourcePlugin({
  site: Site.GALADYNE_IO,
  name: 'Galadyne',
  category: 'company',
})
@Injectable()
export class GaladyneIoService implements IScraper {
  private readonly logger = new Logger(GaladyneIoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout: input.requestTimeout ?? GALADYNE_IO_DEFAULT_TIMEOUT_SECONDS,
      });

      const listingHtml = await this.fetchText(client, GALADYNE_IO_CAREERS_URL);
      const cards = this.parseCards(listingHtml);
      if (cards.length === 0) {
        this.logger.warn('Galadyne: no open roles found');
        return new JobResponseDto([]);
      }

      const content = await this.fetchContent(client, listingHtml);
      const jobs = this.applyInput(
        cards.map((card) => this.toJobPost(card, content.get(card.title))),
        input,
      );

      this.logger.log(`Galadyne: scraped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(`Galadyne scrape failed (${this.errorLabel(error)})`);
      return new JobResponseDto([], classifyScrapeError(error));
    }
  }

  /** GET a URL as text. Isolated so tests can substitute fixtures per URL. */
  protected async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string> {
    const res = await client.get<string>(url, { responseType: 'text' });
    return typeof res.data === 'string' ? res.data : '';
  }

  /**
   * Enumerate the opening cards from the server-rendered listing: each card is
   * an `<h2>` title with a location `<span>` (the geo-pin label) beside it.
   */
  private parseCards(html: string): GaladyneIoCard[] {
    const $ = cheerio.load(html);
    const cards: GaladyneIoCard[] = [];
    const seen = new Set<string>();

    $('h2').each((_i, el) => {
      const title = this.normalize($(el).text());
      if (!title || seen.has(title)) return;
      const location =
        $(el)
          .parent()
          .find('span')
          .toArray()
          .map((span) => this.normalize($(span).text()))
          .find((text) => text.includes(',')) ?? null;
      seen.add(title);
      cards.push({ title, location });
    });

    return cards;
  }

  /**
   * Read the current careers chunk URL from the listing HTML, fetch it, and
   * parse the role → description map. Returns an empty map (never throws) when
   * the chunk can't be located or parsed, so the listing still yields roles.
   */
  private async fetchContent(
    client: ReturnType<typeof createHttpClient>,
    listingHtml: string,
  ): Promise<Map<string, GaladyneIoContent>> {
    const match = GALADYNE_IO_CHUNK_HREF_RE.exec(listingHtml);
    if (!match) {
      this.logger.warn('Galadyne: careers chunk URL not found');
      return new Map();
    }
    try {
      const chunk = await this.fetchText(client, `${GALADYNE_IO_ORIGIN}${match[0]}`);
      return this.parseContent(chunk);
    } catch (error: unknown) {
      this.logger.warn(
        `Galadyne: chunk fetch failed (${this.errorLabel(error)})`,
      );
      return new Map();
    }
  }

  /**
   * Extract the role → description map from the client chunk. The data is a
   * plain object literal `{"<title>":{intro:"…",responsibilities:[…],
   * qualifications:[…],closing:"…"}, …}`; anchor on the `"<title>":{intro:"`
   * boundary (a shape that only occurs in the data object), then read each
   * field by its unmangled key.
   */
  private parseContent(chunk: string): Map<string, GaladyneIoContent> {
    const out = new Map<string, GaladyneIoContent>();
    const entryRe = /"([^"]{2,120})":\{intro:"/g;
    let match: RegExpExecArray | null;
    while ((match = entryRe.exec(chunk)) !== null) {
      const title = this.normalize(this.decode(match[1]));
      if (!title) continue;
      const objStart = chunk.indexOf('{', match.index + match[1].length + 2);
      const obj = this.sliceBraces(chunk, objStart);
      if (!obj) continue;
      out.set(title, {
        intro: this.readString(obj, 'intro'),
        responsibilities: this.readStringArray(obj, 'responsibilities'),
        qualifications: this.readStringArray(obj, 'qualifications'),
        closing: this.readString(obj, 'closing'),
      });
    }
    return out;
  }

  private toJobPost(
    card: GaladyneIoCard,
    content: GaladyneIoContent | undefined,
  ): JobPostDto {
    return new JobPostDto({
      id: `galadyne_io-${this.slugify(card.title)}`,
      site: Site.GALADYNE_IO,
      title: card.title,
      companyName: GALADYNE_IO_COMPANY_NAME,
      companyUrl: GALADYNE_IO_CAREERS_URL,
      jobUrl: GALADYNE_IO_CAREERS_URL,
      applyUrl: GALADYNE_IO_CAREERS_URL,
      location: this.location(card.location),
      isRemote: false,
      description: this.description(content),
      datePosted: null,
      emails: [],
    });
  }

  /** Compose the JD markdown from the structured chunk content. */
  private description(content: GaladyneIoContent | undefined): string | null {
    if (!content) return null;
    const parts: string[] = [];
    if (content.intro) parts.push(content.intro);
    if (content.responsibilities.length) {
      parts.push(
        ['**Responsibilities**', ...content.responsibilities.map((r) => `- ${r}`)].join(
          '\n',
        ),
      );
    }
    if (content.qualifications.length) {
      parts.push(
        ['**Qualifications**', ...content.qualifications.map((q) => `- ${q}`)].join(
          '\n',
        ),
      );
    }
    if (content.closing) parts.push(content.closing);
    return parts.join('\n\n').trim() || null;
  }

  /** Stated per-card location (e.g. `Austin, TX`); null when none is shown. */
  private location(value: string | null): LocationDto | null {
    const text = this.normalize(value);
    if (!text) return null;
    return parseLocationList([text]).location ?? null;
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

    if (input.isRemote === true) {
      filtered = filtered.filter((job) => job.isRemote === true);
    }

    if (input.jobType) {
      filtered = filtered.filter((job) =>
        job.jobType?.includes(input.jobType as JobType),
      );
    }

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(
      input.resultsWanted,
      GALADYNE_IO_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  /** Slice a brace-balanced object substring starting at `{` (string-aware). */
  private sliceBraces(source: string, start: number): string | null {
    if (start < 0 || source[start] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let quote = '';
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return null;
  }

  /** Read a `key:"…"` string literal value from an object substring. */
  private readString(obj: string, key: string): string | null {
    const at = obj.indexOf(`${key}:"`);
    if (at < 0) return null;
    const { value } = this.scanString(obj, at + key.length + 1);
    const text = this.normalize(value);
    return text || null;
  }

  /** Read a `key:["…","…"]` array-of-strings value from an object substring. */
  private readStringArray(obj: string, key: string): string[] {
    const at = obj.indexOf(`${key}:[`);
    if (at < 0) return [];
    const items: string[] = [];
    let i = at + key.length + 2;
    while (i < obj.length) {
      const ch = obj[i];
      if (ch === ']') break;
      if (ch === '"') {
        const scanned = this.scanString(obj, i);
        const text = this.normalize(scanned.value);
        if (text) items.push(text);
        i = scanned.end;
      } else {
        i++;
      }
    }
    return items;
  }

  /**
   * Scan a double-quoted JS string starting at the opening quote index. Returns
   * the decoded value and the index just past the closing quote.
   */
  private scanString(
    source: string,
    openQuote: number,
  ): { value: string; end: number } {
    let raw = '';
    let i = openQuote + 1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '\\') {
        raw += ch + (source[i + 1] ?? '');
        i++;
      } else if (ch === '"') {
        i++;
        break;
      } else {
        raw += ch;
      }
    }
    return { value: this.decode(`"${raw}"`, true), end: i };
  }

  /** Decode a JS/JSON string literal (or a bare `\uXXXX`-bearing token). */
  private decode(value: string, quoted = false): string {
    try {
      return JSON.parse(quoted ? value : `"${value}"`) as string;
    } catch {
      return quoted ? value.replace(/^"|"$/g, '') : value;
    }
  }

  private slugify(title: string): string {
    return this.normalize(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private normalize(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  private errorLabel(error: unknown): string {
    if (!error || typeof error !== 'object') return 'unknown error';
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === 'number') return `HTTP ${status}`;
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
