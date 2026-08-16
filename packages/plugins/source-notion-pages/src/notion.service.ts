import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import { classifyScrapeError,
  CompensationDto,
  DescriptionFormat,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  parseLocationList,
  salaryToCompensation,
  toDateOnly,
} from '@ever-jobs/common';
import {
  NOTION_API_URL,
  NOTION_CHUNK_LIMIT,
  NOTION_DEFAULT_RESULTS,
  NOTION_DETAIL_CONCURRENCY,
  NOTION_HEADERS,
  NOTION_LOCATION_LABEL,
} from './notion.constants';
import {
  NotionBlockRecord,
  NotionBlockValue,
  NotionLoadPageChunkResponse,
  NotionRole,
  NotionRoleDetail,
  NotionTextSegment,
} from './notion.types';

/** A 32-hex Notion id, with or without dashes. */
const NOTION_ID_PATTERN = /[0-9a-f]{32}/gi;
const NOTION_UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type BlockMap = Record<string, NotionBlockRecord>;
type HttpClient = ReturnType<typeof createHttpClient>;

@SourcePlugin({
  site: Site.NOTION_PAGES,
  name: 'Notion',
  category: 'company',
})
@Injectable()
export class NotionService implements IScraper {
  private readonly logger = new Logger(NotionService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const pageId = this.resolvePageId(input.companySlug, input.companyUrl);
    if (!pageId) {
      this.logger.warn(
        'No Notion page id in companySlug/companyUrl for Notion scraper',
      );
      return new JobResponseDto([]);
    }

    const subdomain = this.notionSubdomain(input.companyUrl);

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });
      client.setHeaders(NOTION_HEADERS);

      const rootBlocks = await this.fetchChunk(client, pageId);
      const root = this.block(rootBlocks, pageId);
      if (!root) {
        this.logger.warn(`Notion root page ${pageId} returned no blocks`);
        return new JobResponseDto([]);
      }

      // A career board is either a page whose children are the role pages
      // (handled here) or a database/collection view (a separate mode, not yet
      // built — logged so a real case is visible rather than silently empty).
      const roles = this.enumerateRoles(rootBlocks, root);
      if (roles.length === 0) {
        this.logger.warn(
          `Notion page ${pageId} exposes no child-page roles (collection-view boards are not yet supported)`,
        );
        return new JobResponseDto([]);
      }

      const companyName =
        this.companyNameFromRoot(root) ?? input.companySlug ?? 'Notion';

      const details = await this.fetchDetails(client, roles);
      const jobs = this.applyInput(
        roles.map((role) =>
          this.toJobPost(
            role,
            details.get(role.id),
            companyName,
            subdomain,
            input.descriptionFormat,
          ),
        ),
        input,
      );

      this.logger.log(`Notion: scraped ${jobs.length} jobs for ${pageId}`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(`Notion scrape failed for ${pageId}: ${this.errorLabel(error)}`);
      return new JobResponseDto([], classifyScrapeError(error));
    }
  }

  /** Fetch one page's block chunk and return its recordMap.block. */
  private async fetchChunk(
    client: HttpClient,
    pageId: string,
  ): Promise<BlockMap> {
    const response = await client.post<NotionLoadPageChunkResponse>(
      NOTION_API_URL,
      {
        page: { id: this.toDashedId(pageId) },
        limit: NOTION_CHUNK_LIMIT,
        cursor: { stack: [] },
        chunkNumber: 0,
        verticalColumns: false,
      },
    );
    return response.data?.recordMap?.block ?? {};
  }

  /**
   * The root page's child `page` blocks are the roles. Titles come from the
   * same chunk (Notion inlines child-page titles), so this needs no extra fetch.
   */
  private enumerateRoles(blocks: BlockMap, root: NotionBlockValue): NotionRole[] {
    const roles: NotionRole[] = [];
    const seen = new Set<string>();
    for (const childId of root.content ?? []) {
      const child = this.block(blocks, childId);
      if (!child || child.type !== 'page') continue;
      const title = this.blockTitle(child);
      if (!title || seen.has(childId)) continue;
      seen.add(childId);
      roles.push({ id: childId, title });
    }
    return roles;
  }

  /** Fetch each role sub-page's blocks under bounded concurrency. */
  private async fetchDetails(
    client: HttpClient,
    roles: NotionRole[],
  ): Promise<Map<string, NotionRoleDetail>> {
    const details = new Map<string, NotionRoleDetail>();
    for (let i = 0; i < roles.length; i += NOTION_DETAIL_CONCURRENCY) {
      const batch = roles.slice(i, i + NOTION_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((role) => this.fetchDetail(client, role)),
      );
      settled.forEach((result, index) => {
        details.set(
          batch[index].id,
          result.status === 'fulfilled'
            ? result.value
            : { description: null, locationText: null, createdTime: null },
        );
      });
    }
    return details;
  }

  private async fetchDetail(
    client: HttpClient,
    role: NotionRole,
  ): Promise<NotionRoleDetail> {
    try {
      const blocks = await this.fetchChunk(client, role.id);
      return this.parseRoleDetail(blocks, role);
    } catch (error: unknown) {
      this.logger.warn(
        `Notion role ${role.id} fetch failed (${this.errorLabel(error)})`,
      );
      return { description: null, locationText: null, createdTime: null };
    }
  }

  /**
   * Walk a role page's blocks in order into a description, and pull the labelled
   * `Location:` line if present. The leading header that merely repeats the
   * title is dropped.
   */
  private parseRoleDetail(
    blocks: BlockMap,
    role: NotionRole,
  ): NotionRoleDetail {
    const page = this.block(blocks, role.id);
    if (!page) {
      return { description: null, locationText: null, createdTime: null };
    }

    const lines: string[] = [];
    let locationText: string | null = null;

    (page.content ?? []).forEach((childId, index) => {
      const child = this.block(blocks, childId);
      if (!child) return;
      const text = this.blockTitle(child);
      if (index === 0 && child.type === 'header' && text === role.title) {
        return; // drop the header that duplicates the page title
      }
      if (locationText === null && text) {
        const match = NOTION_LOCATION_LABEL.exec(text);
        if (match) locationText = match[1].trim();
      }
      const rendered = this.renderBlock(child.type, text);
      if (rendered !== null) lines.push(rendered);
    });

    const description = this.collapse(lines.join('\n'));
    return {
      description: description || null,
      locationText,
      createdTime: page.created_time ?? null,
    };
  }

  private toJobPost(
    role: NotionRole,
    detail: NotionRoleDetail | undefined,
    companyName: string,
    subdomain: string | null,
    _format?: DescriptionFormat,
  ): JobPostDto {
    const locationText = detail?.locationText ?? null;
    // parseLocationList strips remote/hybrid qualifiers itself, but not
    // "on-site", so drop that token to keep it out of the parsed location.
    const cleanedLocation = locationText
      ? locationText
          .replace(/\(\s*on[-\s]?site\s*\)/gi, '')
          .replace(/\bon[-\s]?site\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .replace(/[\s,]+$/g, '')
          .trim()
      : null;
    const parsed = parseLocationList([cleanedLocation]);
    const location: LocationDto | null = cleanedLocation ? parsed.location : null;
    const description = detail?.description ?? null;
    const compensation: CompensationDto | null = salaryToCompensation(description);
    const emails = extractEmails(description) ?? [];

    return new JobPostDto({
      id: `notion-${this.dashless(role.id)}`,
      site: Site.NOTION_PAGES,
      title: role.title,
      companyName,
      jobUrl: this.jobUrl(role.id, subdomain),
      location,
      description,
      isRemote: locationText ? parsed.remoteMentioned : null,
      ...(parsed.workFromHomeType
        ? { workFromHomeType: parsed.workFromHomeType }
        : {}),
      ...(compensation ? { compensation } : {}),
      datePosted: detail?.createdTime ? toDateOnly(detail.createdTime) : null,
      // Apply is by email; the address lives in `emails`. `applyUrl` is left
      // unset (a mailto: is not a web URL, and there is no on-site apply page).
      emails,
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
      NOTION_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  /** Render one block to a description line; null = skip (empty/unsupported). */
  private renderBlock(type: string | undefined, text: string): string | null {
    if (!text) return null;
    switch (type) {
      case 'header':
        return `## ${text}`;
      case 'sub_header':
        return `### ${text}`;
      case 'sub_sub_header':
        return `#### ${text}`;
      case 'bulleted_list':
      case 'numbered_list':
      case 'toggle':
        return `- ${text}`;
      case 'to_do':
        return `- [ ] ${text}`;
      case 'quote':
        return `> ${text}`;
      default:
        return text;
    }
  }

  /** Join a rich-text run's segments into plain text. */
  private segmentsText(segments?: NotionTextSegment[]): string {
    if (!segments) return '';
    return segments
      .map((segment) => (typeof segment[0] === 'string' ? segment[0] : ''))
      .join('');
  }

  private blockTitle(block: NotionBlockValue): string {
    return this.segmentsText(block.properties?.title).trim();
  }

  /**
   * Resolve a block record to its real value, tolerating both the flat
   * `{ role, value }` and nested `{ value: { role, value } }` envelopes.
   */
  private block(blocks: BlockMap, id: string): NotionBlockValue | null {
    // recordMap keys may be dashed or dashless depending on the request form;
    // resolve against both so callers can pass either.
    let node: NotionBlockRecord | NotionBlockValue | undefined =
      blocks[id] ?? blocks[this.toDashedId(id)] ?? blocks[this.dashless(id)];
    let guard = 0;
    while (
      node &&
      typeof node === 'object' &&
      !('type' in node) &&
      'value' in node &&
      guard < 5
    ) {
      node = (node as NotionBlockRecord).value;
      guard += 1;
    }
    return node && typeof node === 'object' && 'id' in node
      ? (node as NotionBlockValue)
      : null;
  }

  /** Derive a company name from the board's root title (`Careers at X` → `X`). */
  private companyNameFromRoot(root: NotionBlockValue): string | null {
    const title = this.blockTitle(root);
    if (!title) return null;
    const stripped = title
      .replace(/^careers?\s+(?:at|@|-|–|—|for|with)\s+/i, '')
      .replace(/\s*[-–—|]\s*careers?\s*$/i, '')
      .trim();
    return stripped || title;
  }

  /** The notion.site subdomain from a companyUrl, when it is a notion.site URL. */
  private notionSubdomain(companyUrl?: string | null): string | null {
    if (!companyUrl) return null;
    try {
      const host = new URL(companyUrl).hostname.toLowerCase();
      if (host.endsWith('.notion.site')) return host.slice(0, -'.notion.site'.length);
    } catch {
      return null;
    }
    return null;
  }

  private jobUrl(id: string, subdomain: string | null): string {
    const host = subdomain ? `${subdomain}.notion.site` : 'www.notion.so';
    return `https://${host}/${this.dashless(id)}`;
  }

  /** Extract a Notion page id from a slug or URL and return it dashless. */
  private resolvePageId(
    companySlug?: string | null,
    companyUrl?: string | null,
  ): string | null {
    for (const raw of [companySlug, companyUrl]) {
      if (!raw) continue;
      const uuid = NOTION_UUID_PATTERN.exec(raw);
      if (uuid) return this.dashless(uuid[0]);
      const matches = raw.match(NOTION_ID_PATTERN);
      if (matches && matches.length) return this.dashless(matches[matches.length - 1]);
    }
    return null;
  }

  private dashless(id: string): string {
    return id.replace(/-/g, '').toLowerCase();
  }

  private toDashedId(id: string): string {
    const hex = this.dashless(id);
    if (hex.length !== 32) return id;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private collapse(body: string): string {
    return body
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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
    const status = (error as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number') return `HTTP ${status}`;
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
