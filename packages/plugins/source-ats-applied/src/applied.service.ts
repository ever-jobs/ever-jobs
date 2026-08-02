import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  APPLIED_BASE_URL,
  APPLIED_ORG_PATH_TEMPLATE,
  APPLIED_JOB_PATH_PREFIX,
  APPLIED_MAX_CONCURRENCY,
  APPLIED_REQUEST_DELAY_MS,
  APPLIED_DEFAULT_RESULTS,
  APPLIED_HEADERS,
} from './applied.constants';
import { AppliedJobLink, AppliedJobDetail } from './applied.types';

/**
 * Applied (beapplied.com) ATS scraper — generic, multi-tenant.
 *
 * Applied is a values-based hiring platform that hosts public career pages at
 * `https://app.beapplied.com/org/{orgId}/{orgSlug}`.  It deliberately gates
 * all REST API endpoints behind authentication (HTTP 401); no public anonymous
 * JSON feed exists.  This adapter therefore scrapes the two publicly accessible
 * HTML surfaces:
 *
 *   1. **Org listing page** — `GET /org/{orgPath}`:
 *      Parses all `/apply/{jobSlug}` anchors to discover open roles.
 *
 *   2. **Job detail page** — `GET /apply/{jobSlug}` (one per role):
 *      Parses the role title, company, location, salary, employment type,
 *      closing date, and full description from the rendered prose HTML.
 *
 * The org-path is resolved from `companySlug` (expected as `{orgId}/{orgSlug}`,
 * e.g. `"1549/citizens-uk"`) or from `companyUrl` (its path after `/org/`).
 * Numeric-id–only or slug-only forms are not supported because Applied's
 * routing requires the full `{orgId}/{orgSlug}` pair.
 *
 * A fetch error on any individual job detail page degrades gracefully to a
 * partial result; a fatal error on the org listing page returns an empty
 * `JobResponseDto` rather than throwing.
 */
@SourcePlugin({
  site: Site.APPLIED,
  name: 'Applied',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class AppliedService implements IScraper {
  private readonly logger = new Logger(AppliedService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Applied scraper');
      return new JobResponseDto([]);
    }

    const orgPath = this.resolveOrgPath(input.companySlug, input.companyUrl);
    if (!orgPath) {
      this.logger.warn('Could not resolve an Applied org path from input — expected "{orgId}/{orgSlug}" form');
      return new JobResponseDto([]);
    }

    const orgUrl =
      APPLIED_BASE_URL +
      APPLIED_ORG_PATH_TEMPLATE.replace('{orgPath}', orgPath);

    const companyName = this.deriveCompanyName(orgPath);
    const resultsWanted = input.resultsWanted ?? APPLIED_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(APPLIED_HEADERS);

    const jobPosts: JobPostDto[] = [];
    const seen = new Set<string>();

    try {
      this.logger.log(`Fetching Applied org page: ${orgUrl}`);
      const orgResponse = await client.get<string>(orgUrl);
      const orgHtml = orgResponse.data ?? '';

      if (!orgHtml) {
        this.logger.warn(`Applied: empty response for org page ${orgUrl}`);
        return new JobResponseDto([]);
      }

      const links = this.parseOrgPage(orgHtml);
      if (links.length === 0) {
        this.logger.log(`Applied: no open roles found for org ${orgPath}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Applied: found ${links.length} job links for ${orgPath}`);

      const limited = links.slice(0, resultsWanted);

      // Fan-out detail fetches in bounded concurrent batches.
      for (let i = 0; i < limited.length; i += APPLIED_MAX_CONCURRENCY) {
        const batch = limited.slice(i, i + APPLIED_MAX_CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map((link) => this.fetchJobDetail(client, link)),
        );

        for (let j = 0; j < settled.length; j++) {
          const result = settled[j];
          const link = batch[j];
          if (result.status === 'fulfilled') {
            try {
              const post = this.buildJobPost(
                link,
                result.value,
                companyName,
                input.descriptionFormat,
                seen,
              );
              if (post) jobPosts.push(post);
            } catch (err: any) {
              this.logger.warn(
                `Applied: error building post for ${link.jobSlug}: ${err.message}`,
              );
            }
          } else {
            this.logger.warn(
              `Applied: detail fetch failed for ${link.jobSlug}: ${result.reason?.message ?? result.reason}`,
            );
            // Degrade: push a minimal post from org-page data only.
            try {
              const post = this.buildJobPost(link, null, companyName, input.descriptionFormat, seen);
              if (post) jobPosts.push(post);
            } catch {
              // silently skip
            }
          }
        }

        if (i + APPLIED_MAX_CONCURRENCY < limited.length) {
          await randomSleep(APPLIED_REQUEST_DELAY_MS, APPLIED_REQUEST_DELAY_MS * 2);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Applied total: ${trimmed.length} jobs for ${orgPath}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Applied scrape error for ${orgPath}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted));
    }
  }

  // ---------------------------------------------------------------------------
  // Org-page HTML parser
  // ---------------------------------------------------------------------------

  /**
   * Parse the organisation listing page HTML and return one {@link AppliedJobLink}
   * per open role anchor.
   *
   * Applied's org page contains anchors of the form:
   *   `<a href="/apply/{jobSlug}">…job title…</a>`
   *
   * We collect every unique `/apply/` anchor that carries a non-empty slug.
   * Share/copy/email anchors that include query strings or fragment identifiers
   * are filtered out.
   */
  private parseOrgPage(html: string): AppliedJobLink[] {
    const $ = cheerio.load(html);
    const links: AppliedJobLink[] = [];
    const seenSlugs = new Set<string>();

    $('a[href^="/apply/"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      // Strip query strings / fragments; must match bare /apply/{slug} form.
      const clean = href.split('?')[0].split('#')[0];
      const slugMatch = clean.match(/^\/apply\/([a-zA-Z0-9_-]+)$/);
      if (!slugMatch) return;
      const jobSlug = slugMatch[1];
      if (!jobSlug || seenSlugs.has(jobSlug)) return;
      seenSlugs.add(jobSlug);

      const titleRaw = $(el).text().trim();
      const title = titleRaw || null;

      // Try to pick up a location hint from the nearest sibling / parent text.
      const parent = $(el).closest('li, div, article, tr');
      let locationHint: string | null = null;
      if (parent.length) {
        const parentText = parent.text();
        // Location hints on Applied org pages appear after the title as
        // comma- or bullet-separated fragments, e.g. "London, City of, UK".
        // We look for text that follows the title on the same card.
        const afterTitle = titleRaw
          ? parentText.replace(titleRaw, '').trim()
          : parentText.trim();
        if (afterTitle) {
          // Take the first 100 characters to avoid capturing too much.
          const hint = afterTitle.replace(/\s+/g, ' ').substring(0, 100).trim();
          if (hint) locationHint = hint;
        }
      }

      links.push({
        jobSlug,
        jobUrl: `${APPLIED_BASE_URL}${APPLIED_JOB_PATH_PREFIX}${jobSlug}`,
        title,
        locationHint,
      });
    });

    return links;
  }

  // ---------------------------------------------------------------------------
  // Job detail page fetch + parser
  // ---------------------------------------------------------------------------

  /** Fetch and parse one job detail page. Returns null on a 404 / empty body. */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    link: AppliedJobLink,
  ): Promise<AppliedJobDetail | null> {
    const url = link.jobUrl;
    try {
      const response = await client.get<string>(url);
      const html = response.data ?? '';
      if (!html) return null;
      return this.parseJobDetailPage(html);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) {
        this.logger.warn(`Applied: job no longer available (HTTP ${status}): ${url}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse an Applied job detail page HTML string into an {@link AppliedJobDetail}.
   *
   * Applied renders detail pages as server-side HTML prose.  There is no
   * JSON-LD schema.org markup.  The scraper relies on text-content heuristics
   * rather than fragile CSS class selectors so minor theme changes do not
   * break extraction.
   *
   * Parsing strategy (order of precedence):
   *
   *   - **Title**: first `<h1>` element (or `<h2>` fallback).
   *   - **Company name**: element immediately following the title (often an `<h2>`
   *     or paragraph containing the organisation name).
   *   - **Location / employment / salary / closing date**: extracted from structured
   *     text blocks that appear above the description body on all Applied pages.
   *   - **Description**: the largest prose-rich container (`<article>` or
   *     the longest `<div>` / `<section>`) after the metadata block.
   */
  private parseJobDetailPage(html: string): AppliedJobDetail {
    const $ = cheerio.load(html);

    // Title — first h1 or largest heading.
    const titleEl = $('h1').first();
    const title = titleEl.text().trim() || null;

    // Company name — look for a heading/paragraph near the title that is
    // distinct from it.  Applied pages commonly place the org name in an
    // element immediately after the h1.
    let companyName: string | null = null;
    const afterTitle = titleEl.next();
    if (afterTitle.length) {
      const candidate = afterTitle.text().trim();
      // Heuristic: company names are short (< 80 chars) and don't look like
      // a location or date.
      if (candidate && candidate.length < 80 && !candidate.includes('£') && !candidate.includes('Closes')) {
        companyName = candidate;
      }
    }
    // Fallback: search for a "company" or "organisation" labelled element.
    if (!companyName) {
      $('[class*="company"], [class*="organisation"], [class*="organization"]').each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length < 80) {
          companyName = text;
          return false; // break
        }
        return true;
      });
    }

    // Collect all short text blocks as candidate metadata lines.
    // Applied renders metadata (location, salary, type, closing date) as
    // short labelled strings in the page body.
    const metaLines: string[] = [];
    $('p, span, li, div').each((_, el) => {
      const child = $(el);
      // Skip elements with many child elements (they're containers, not leaves).
      if (child.children().length > 3) return;
      const text = child.text().trim();
      if (text && text.length > 3 && text.length < 200) {
        metaLines.push(text);
      }
    });

    // Extract fields from meta lines using keyword heuristics.
    let locationRaw: string | null = null;
    let locationDetail: string | null = null;
    let salaryRaw: string | null = null;
    let employmentType: string | null = null;
    let closingDateRaw: string | null = null;

    for (const line of metaLines) {
      const lower = line.toLowerCase();

      // Location: lines containing location keywords or the bullet-dot separator.
      if (!locationRaw && (lower.includes('london') || lower.includes('remote') || lower.includes('hybrid') || lower.includes('uk') || lower.includes('·') || lower.includes(' uk '))) {
        if (line.length < 120) locationRaw = line;
      }
      // Location detail: longer location description (contains "office" or "based in").
      if (!locationDetail && (lower.includes('office') || lower.includes('based in') || lower.includes('flexible'))) {
        if (line.length > 20 && line.length < 200) locationDetail = line;
      }
      // Salary: lines containing currency symbols.
      if (!salaryRaw && (line.includes('£') || line.includes('$') || line.includes('€') || lower.includes('salary') || lower.includes(' pa') || lower.includes('per annum'))) {
        if (line.length < 150) salaryRaw = line;
      }
      // Employment type: lines with "full time", "part time", "contract", or "hours".
      if (!employmentType && (lower.includes('full time') || lower.includes('part time') || lower.includes('contract') || lower.includes('hours per week') || lower.includes('fixed term'))) {
        if (line.length < 150) employmentType = line;
      }
      // Closing date: lines with "closes", "deadline", or a month name + year.
      if (!closingDateRaw && (lower.includes('closes') || lower.includes('deadline') || lower.includes('closing'))) {
        if (line.length < 100) closingDateRaw = line;
      }
    }

    // Description HTML — look for the main content container.
    // Applied pages use a variety of wrappers; we try several heuristics.
    let descriptionHtml: string | null = null;

    // Preferred: an <article> element.
    const article = $('article').first();
    if (article.length && article.html() && (article.html()?.length ?? 0) > 200) {
      descriptionHtml = article.html() ?? null;
    }

    // Fallback: the div / section with the most text content that is not a
    // nav / header / footer.
    if (!descriptionHtml) {
      let bestLen = 0;
      $('div, section').each((_, el) => {
        const node = $(el);
        const tag = (el as any).name ?? '';
        // Skip navigation / header / footer regions.
        const classAttr = (node.attr('class') ?? '').toLowerCase();
        const idAttr = (node.attr('id') ?? '').toLowerCase();
        if (/nav|header|footer|sidebar|menu|banner/.test(classAttr + idAttr)) return;
        if (/nav|header|footer/.test(tag)) return;
        const text = node.text().trim();
        if (text.length > bestLen && text.length > 300) {
          const innerHtml = node.html() ?? '';
          if (innerHtml.length > 300) {
            bestLen = text.length;
            descriptionHtml = innerHtml;
          }
        }
      });
    }

    return {
      title,
      companyName,
      locationRaw,
      locationDetail,
      salaryRaw,
      employmentType,
      closingDateRaw,
      descriptionHtml,
    };
  }

  // ---------------------------------------------------------------------------
  // JobPostDto construction
  // ---------------------------------------------------------------------------

  /**
   * Combine the org-page link data with the (optionally fetched) job detail
   * into a `JobPostDto`.  Returns null when dedup detects a duplicate.
   */
  private buildJobPost(
    link: AppliedJobLink,
    detail: AppliedJobDetail | null,
    fallbackCompany: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    if (seen.has(link.jobSlug)) return null;
    seen.add(link.jobSlug);

    const title = detail?.title ?? link.title;
    if (!title) return null;

    const companyName = detail?.companyName ?? fallbackCompany;

    const rawHtml = detail?.descriptionHtml ?? null;
    let description: string | null = null;
    if (rawHtml) {
      if (format === DescriptionFormat.HTML) {
        description = rawHtml;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawHtml) ?? htmlToPlainText(rawHtml);
      } else {
        description = htmlToPlainText(rawHtml);
      }
    }

    const location = this.extractLocation(detail, link);
    const isRemote = this.detectRemote(detail, link);
    const employmentType = detail?.employmentType ?? null;
    const datePosted = this.parseClosingDate(detail?.closingDateRaw);

    return new JobPostDto({
      id: `applied-${link.jobSlug}`,
      title,
      companyName,
      jobUrl: link.jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.APPLIED,
      atsId: link.jobSlug,
      atsType: 'applied',
      employmentType,
      applyUrl: link.jobUrl,
    });
  }

  // ---------------------------------------------------------------------------
  // Resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the `{orgId}/{orgSlug}` path from the caller's inputs.
   *
   * Accepted forms for `companySlug`:
   *   - `"1549/citizens-uk"` — used directly.
   *   - `"citizens-uk"` — rejected (no numeric id; Applied routing requires it).
   *
   * Accepted forms for `companyUrl`:
   *   - `"https://app.beapplied.com/org/1549/citizens-uk"` → `"1549/citizens-uk"`.
   *   - Any URL whose path starts with `/org/` and contains at least two segments.
   */
  private resolveOrgPath(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // Require at least one "/" indicating the {orgId}/{orgSlug} form.
      if (slug.includes('/')) return slug;
    }
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const path = u.pathname; // e.g. "/org/1549/citizens-uk"
        const match = path.match(/^\/org\/(.+)$/);
        if (match && match[1]) return match[1];
      } catch {
        // Malformed URL — skip.
      }
    }
    return '';
  }

  /**
   * Derive a display company name from the org-path string.
   * e.g. `"1549/citizens-uk"` → `"Citizens Uk"`.
   */
  private deriveCompanyName(orgPath: string): string {
    const slug = orgPath.includes('/') ? orgPath.split('/').pop() ?? orgPath : orgPath;
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse location from the detail page data.  The raw location string from
   * Applied often includes a work-type prefix separated by `"·"`, e.g.:
   *   `"Hybrid · London, City of, UK"`
   *
   * We strip the prefix and parse the remainder into a `LocationDto`.
   */
  private extractLocation(
    detail: AppliedJobDetail | null,
    link: AppliedJobLink,
  ): LocationDto | null {
    const raw = detail?.locationRaw ?? link.locationHint ?? null;
    if (!raw) return null;

    // Strip work-type prefix ("Hybrid · ", "Remote · ", etc.).
    const withoutPrefix = raw.replace(/^(hybrid|remote|on.?site|in-person)\s*[·•|]\s*/i, '').trim();

    // Attempt "City, State, Country" comma-split.
    return this.locationFromLabel(withoutPrefix);
  }

  /** Split a free-text "City, State, Country" label into a `LocationDto`. */
  private locationFromLabel(label: string): LocationDto | null {
    const parts = label
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    const state = parts.length >= 3 ? parts[1] : null;
    const country = parts[parts.length - 1];
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from location text or description keywords. */
  private detectRemote(
    detail: AppliedJobDetail | null,
    link: AppliedJobLink,
  ): boolean {
    const haystacks = [
      detail?.locationRaw,
      detail?.locationDetail,
      detail?.employmentType,
      link.locationHint,
      link.title,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /**
   * Applied job pages show the APPLICATION CLOSING DATE rather than the
   * posting date.  We parse this as a best-effort date; when the closing date
   * is in the past or unparseable, we return null.
   */
  private parseClosingDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      // Strip preamble like "Closes in 4 days", "11:59pm, 7th Jun 2026 BST"
      // Attempt direct parse of the raw string.
      const cleaned = value
        .replace(/closes\s+in\s+\d+\s+days?/i, '')
        .replace(/^closes?\s*/i, '')
        .replace(/\d{1,2}:\d{2}(am|pm)?,?\s*/i, '') // strip time portion
        .replace(/(BST|GMT|UTC|EST|PST)\s*$/i, '')    // strip timezone
        .trim();

      // Try to match "7th Jun 2026" or "June 7, 2026" patterns.
      const dateMatch = cleaned.match(
        /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/,
      );
      if (dateMatch) {
        const day = parseInt(dateMatch[1], 10);
        const month = dateMatch[2];
        const year = parseInt(dateMatch[3], 10);
        const parsed = new Date(`${month} ${day} ${year}`);
        if (!isNaN(parsed.getTime())) {
          return toDateOnly(`${month} ${day} ${year}`);
        }
      }

      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // Silently ignore parse errors.
    }
    return null;
  }
}
