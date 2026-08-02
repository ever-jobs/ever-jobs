import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  CompensationDto,
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
  decodeHtmlEntities,
  extractEmails,
  parseLocationList,
  salaryToCompensation,
} from '@ever-jobs/common';
import {
  TERRAFORMINDUSTRIES_CAREERS_HEADING,
  TERRAFORMINDUSTRIES_CAREERS_URL,
  TERRAFORMINDUSTRIES_COMPANY_NAME,
  TERRAFORMINDUSTRIES_DEFAULT_RESULTS,
  TERRAFORMINDUSTRIES_DEFAULT_TIMEOUT_SECONDS,
  TERRAFORMINDUSTRIES_DETAIL_CONCURRENCY,
  TERRAFORMINDUSTRIES_DOC_DOMAIN_MARKER,
  terraformIndustriesDocExportUrl,
  terraformIndustriesDocUrl,
} from './terraformindustries.constants';

/** A role parsed from the Careers list before Google Doc enrichment. */
interface TerraformRole {
  title: string;
  docId: string;
}

/** Fields pulled from a role's Google Doc plain-text export. */
interface TerraformDocDetail {
  location: string | null;
  description: string | null;
  payText: string | null;
}

const DOC_ID_PATTERN = /\/document\/d\/([A-Za-z0-9_-]+)/;

/** The line the job docs use to state the salary band. */
const PAY_RANGE_PATTERN = /pay range:[^\n]*/i;

@SourcePlugin({
  site: Site.TERRAFORMINDUSTRIES,
  name: 'Terraform Industries',
  category: 'company',
})
@Injectable()
export class TerraformIndustriesService implements IScraper {
  private readonly logger = new Logger(TerraformIndustriesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        requestTimeout:
          input.requestTimeout ?? TERRAFORMINDUSTRIES_DEFAULT_TIMEOUT_SECONDS,
      });

      const response = await client.get<string>(
        TERRAFORMINDUSTRIES_CAREERS_URL,
        { responseType: 'text' },
      );
      const html =
        typeof response.data === 'string' ? response.data : String(response.data);
      if (!html) {
        this.logger.warn('Terraform Industries returned an empty home page');
        return new JobResponseDto([]);
      }

      const roles = this.parseRoles(html);
      if (roles.length === 0) {
        this.logger.warn(
          'Terraform Industries careers list contained no recognized roles',
        );
        return new JobResponseDto([]);
      }

      const details = await this.fetchDetails(client, roles);
      const jobs = this.applyInput(
        roles.map((role) => this.toJobPost(role, details.get(role.docId))),
        input,
      );

      this.logger.log(`Terraform Industries: scraped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(
        `Terraform Industries scrape failed (${this.errorLabel(error)})`,
      );
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse the Careers list. The section is a flat run of anchors, so scope to
   * the markup after the "Careers" heading and keep only Google Doc links.
   */
  private parseRoles(html: string): TerraformRole[] {
    const headingIndex = html.search(
      new RegExp(`<b>\\s*${TERRAFORMINDUSTRIES_CAREERS_HEADING}\\s*</b>`, 'i'),
    );
    const scoped = headingIndex >= 0 ? html.slice(headingIndex) : html;

    const $ = cheerio.load(scoped);
    const roles: TerraformRole[] = [];
    const seen = new Set<string>();

    $('a[href*="docs.google.com/document/"]').each((_index, element) => {
      const href = $(element).attr('href') ?? '';
      const docId = DOC_ID_PATTERN.exec(href)?.[1];
      if (!docId) return;

      const title = this.normalize($(element).text());
      if (!title) return;

      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      roles.push({ title, docId });
    });

    return roles;
  }

  /**
   * Fetch each distinct Google Doc export once (bounded concurrency). A shared
   * doc — e.g. the generic technician description reused by several roles — is
   * fetched a single time and reused by docId.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    roles: TerraformRole[],
  ): Promise<Map<string, TerraformDocDetail>> {
    const uniqueDocIds = [...new Set(roles.map((role) => role.docId))];
    const details = new Map<string, TerraformDocDetail>();

    for (
      let index = 0;
      index < uniqueDocIds.length;
      index += TERRAFORMINDUSTRIES_DETAIL_CONCURRENCY
    ) {
      const batch = uniqueDocIds.slice(
        index,
        index + TERRAFORMINDUSTRIES_DETAIL_CONCURRENCY,
      );
      const settled = await Promise.allSettled(
        batch.map((docId) => this.fetchDoc(client, docId)),
      );
      settled.forEach((result, batchIndex) => {
        details.set(
          batch[batchIndex],
          result.status === 'fulfilled'
            ? result.value
            : { location: null, description: null, payText: null },
        );
      });
    }

    return details;
  }

  private async fetchDoc(
    client: ReturnType<typeof createHttpClient>,
    docId: string,
  ): Promise<TerraformDocDetail> {
    try {
      const response = await client.get<string>(
        terraformIndustriesDocExportUrl(docId),
        { responseType: 'text' },
      );
      const text =
        typeof response.data === 'string'
          ? response.data
          : String(response.data);
      return this.parseDoc(text);
    } catch (error: unknown) {
      this.logger.warn(
        `Terraform Industries doc ${docId} fetch failed (${this.errorLabel(error)})`,
      );
      return { location: null, description: null, payText: null };
    }
  }

  /**
   * A job doc's plain-text export opens with a fixed header: company name,
   * title, the `terraformindustries.com` domain, then the location, then a
   * blank line and the description body. Use the domain line as the anchor:
   * the next non-empty line is the location and the remainder is the body.
   */
  private parseDoc(text: string): TerraformDocDetail {
    if (!text || !text.toLowerCase().includes(TERRAFORMINDUSTRIES_DOC_DOMAIN_MARKER)) {
      return { location: null, description: null, payText: null };
    }

    const lines = text.split(/\r?\n/);
    const domainIndex = lines.findIndex(
      (line) =>
        line.trim().toLowerCase() === TERRAFORMINDUSTRIES_DOC_DOMAIN_MARKER,
    );
    if (domainIndex < 0) return { location: null, description: null, payText: null };

    let location: string | null = null;
    let bodyStart = lines.length;
    for (let index = domainIndex + 1; index < lines.length; index++) {
      if (lines[index].trim()) {
        location = lines[index].trim();
        bodyStart = index + 1;
        break;
      }
    }

    const description = this.normalizeBody(lines.slice(bodyStart).join('\n'));
    const payText = PAY_RANGE_PATTERN.exec(text)?.[0].trim() ?? null;
    return { location, description, payText };
  }

  /** Collapse runs of blank lines and trim; keep single line breaks intact. */
  private normalizeBody(body: string): string | null {
    const cleaned = body
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return cleaned || null;
  }

  private toJobPost(
    role: TerraformRole,
    detail: TerraformDocDetail | undefined,
  ): JobPostDto {
    const parsedLocation = parseLocationList([detail?.location ?? null]);
    const location: LocationDto | null = detail?.location
      ? parsedLocation.location
      : null;
    const description = detail?.description ?? null;
    const compensation: CompensationDto | null = detail?.payText
      ? salaryToCompensation(detail.payText)
      : null;

    return new JobPostDto({
      id: `terraformindustries-${this.slug(role.title)}`,
      site: Site.TERRAFORMINDUSTRIES,
      title: role.title,
      companyName: TERRAFORMINDUSTRIES_COMPANY_NAME,
      companyUrl: TERRAFORMINDUSTRIES_CAREERS_URL,
      jobUrl: terraformIndustriesDocUrl(role.docId),
      location,
      description,
      isRemote: detail?.location ? parsedLocation.remoteMentioned : null,
      ...(parsedLocation.workFromHomeType
        ? { workFromHomeType: parsedLocation.workFromHomeType }
        : {}),
      ...(compensation ? { compensation } : {}),
      datePosted: null,
      emails: extractEmails(description),
    });
  }

  private applyInput(
    jobs: JobPostDto[],
    input: ScraperInputDto,
  ): JobPostDto[] {
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
      TERRAFORMINDUSTRIES_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slug(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
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
