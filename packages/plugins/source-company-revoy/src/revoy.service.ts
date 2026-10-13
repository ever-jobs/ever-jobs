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
  extractJobType,
  parseLocationText,
} from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import {
  REVOY_CAREERS_URL,
  REVOY_COMPANY_NAME,
  REVOY_DEFAULT_TIMEOUT_SECONDS,
  REVOY_DOC_DEPARTMENT_BLOCK_RE,
  REVOY_DOC_DEPARTMENT_RE,
  REVOY_DOC_EXPORT,
  REVOY_DOC_ID_RE,
  REVOY_DOC_LOCATION_BLOCK_RE,
  REVOY_DOC_LOCATION_RE,
  REVOY_DOC_TYPE_RE,
  REVOY_HYBRID_RE,
  REVOY_LINK_SELECTOR,
  REVOY_ONSITE_RE,
  REVOY_ORIGIN,
  REVOY_REMOTE_RE,
  REVOY_ROW_LOCATION_RE,
} from './revoy.constants';
import { RevoyJobRef } from './revoy.types';

@SourcePlugin({
  site: Site.REVOY,
  name: REVOY_COMPANY_NAME,
  category: 'company',
  companyDomains: ['revoy.com'],
})
@Injectable()
export class RevoyService implements IScraper {
  private readonly logger = new Logger(RevoyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no role links on the Revoy careers page'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Revoy: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(`Revoy scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`);
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? REVOY_DEFAULT_TIMEOUT_SECONDS,
    });

    const careersUrl = this.normalize(input.companyUrl) || REVOY_CAREERS_URL;
    const indexRes = await client.get<string>(careersUrl);
    const refs = this.parseIndex(cheerio.load(String(indexRes.data ?? '')));
    if (refs.length === 0) return [];

    const jobs: JobPostDto[] = [];
    for (const ref of refs) {
      const docRes = await client.get<string>(REVOY_DOC_EXPORT(ref.docId)).catch(() => null);
      const docText = docRes ? String(docRes.data ?? '') : null;
      const job = this.buildJob(ref, docText);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /** `.text-label-medium` rows: `<a class="link-12" href="…/document/d/{id}/…">{title}</a> — {place}`. */
  private parseIndex($: cheerio.CheerioAPI): RevoyJobRef[] {
    const refs: RevoyJobRef[] = [];
    const seen = new Set<string>();
    $(REVOY_LINK_SELECTOR).each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href')?.trim();
      const docId = href ? REVOY_DOC_ID_RE.exec(href)?.[1] : null;
      const title = this.normalize($a.text());
      if (!docId || !title || seen.has(docId)) return;
      seen.add(docId);
      const rowText = this.normalize($a.parent().text());
      const linkLocation = REVOY_ROW_LOCATION_RE.exec(rowText)?.[1]?.trim() || null;
      refs.push({ docId, docUrl: href as string, title, linkLocation });
    });
    return refs;
  }

  private buildJob(ref: RevoyJobRef, docText: string | null): JobPostDto | null {
    const doc = docText ? this.parseDoc(docText) : null;

    const locationText = doc?.locationText ?? ref.linkLocation;
    const location = locationText ? parseLocationText(locationText)?.location ?? null : null;
    const workFromHomeType =
      doc?.locationText && REVOY_ONSITE_RE.test(doc.locationText)
        ? 'On Site'
        : doc?.locationText && REVOY_REMOTE_RE.test(doc.locationText)
          ? 'Remote'
          : doc?.locationText && REVOY_HYBRID_RE.test(doc.locationText)
            ? 'Hybrid'
            : undefined;
    const jobType = doc?.typeText
      ? extractJobType(doc.typeText.replace(/-/g, ' ')) ?? undefined
      : undefined;

    return new JobPostDto({
      id: `revoy-${ref.docId}`,
      atsId: ref.docId,
      site: Site.REVOY,
      atsType: 'revoy',
      title: ref.title,
      companyName: REVOY_COMPANY_NAME,
      companyUrl: REVOY_ORIGIN,
      jobUrl: ref.docUrl,
      jobUrlDirect: ref.docUrl,
      applyUrl: ref.docUrl,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(doc?.description ? { description: doc.description } : {}),
      ...(doc?.department ? { department: doc.department } : {}),
      ...(doc?.typeText ? { employmentType: doc.typeText } : {}),
      ...(jobType ? { jobType } : {}),
      ...(workFromHomeType ? { workFromHomeType } : {}),
    });
  }

  /**
   * Doc headers vary: `Location: Troutdale, OR (on-site)` vs caps blocks
   * `LOCATION\tPortland, OR` / `FUNCTION\tFinance`. Labeled lines win;
   * caps blocks are a fallback; the rest is description text.
   */
  private parseDoc(text: string): {
    locationText: string | null;
    department: string | null;
    typeText: string | null;
    description: string;
  } {
    const locationText =
      REVOY_DOC_LOCATION_RE.exec(text)?.[1]?.trim() ||
      REVOY_DOC_LOCATION_BLOCK_RE.exec(text)?.[1]?.trim() ||
      null;
    const department =
      REVOY_DOC_DEPARTMENT_RE.exec(text)?.[1]?.trim() ||
      REVOY_DOC_DEPARTMENT_BLOCK_RE.exec(text)?.[1]?.trim() ||
      null;
    const typeText = REVOY_DOC_TYPE_RE.exec(text)?.[1]?.trim() || null;
    return { locationText, department, typeText, description: text.trim() };
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
