import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
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
  toDateOnly,
} from '@ever-jobs/common';
import {
  AVIONTE_FEED_ORIGIN,
  AVIONTE_FEED_DOMAIN,
  AVIONTE_PORTAL_DOMAIN,
  AVIONTE_RSS_PATH,
  AVIONTE_XML_FORMAT_QUERY,
  AVIONTE_DEFAULT_RESULTS,
  AVIONTE_HEADERS,
  AVIONTE_ITEM_REGEX,
  AVIONTE_TAG_REGEX_TEMPLATE,
  AVIONTE_COMPID_REGEX,
  AVIONTE_JOB_ID_REGEX,
  AVIONTE_REMOTE_REGEX,
} from './avionte.constants';
import { AvionteFeed, AvionteJob } from './avionte.types';

/**
 * Avionté (AviontéBOLD) ATS careers scraper — generic, multi-tenant.
 *
 * Avionté (avionte.com, US staffing & recruiting ATS) publishes every
 * customer "build"'s posted jobs through a public, unauthenticated RSS/XML feed
 * that powers its branded careers page:
 * `GET https://www.myavionte.com/buildjobs_rss.aspx?compid={buildId}` (with
 * `&format=xml` for the richer, extended XML variant carrying body / posted
 * date / employment type). The feed returns every posted job for the build in
 * one response — there is no server-side pagination — so we fetch once and
 * slice client-side to honour `resultsWanted`.
 *
 * The caller addresses a build by `companySlug` (used as the `compid` build id)
 * or by a full `companyUrl` (a `buildjobs_rss.aspx?compid=…` feed URL, or a
 * `*.aviontego.com` portal URL / `?CompanyID=` query from which the build id is
 * recovered). A single fetch error, an unknown build (HTTP 4xx), or a malformed
 * / non-XML payload degrades to an empty result rather than throwing, so a
 * single build never nukes a batch run.
 */
@SourcePlugin({
  site: Site.AVIONTE,
  name: 'Avionté',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class AvionteService implements IScraper {
  private readonly logger = new Logger(AvionteService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Avionté scraper');
      return new JobResponseDto([]);
    }

    const buildId = this.resolveBuildId(companySlug, input.companyUrl);
    if (!buildId) {
      this.logger.warn('Could not resolve an Avionté build id from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(AVIONTE_HEADERS);

    const resultsWanted = input.resultsWanted ?? AVIONTE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Avionté jobs for build: ${buildId}`);

      // The RSS/XML export returns every posted job for the build at once.
      const feed = await this.fetchFeed(client, buildId);
      if (!feed) {
        this.logger.warn(`Avionté feed for build "${buildId}" returned no jobs`);
        return new JobResponseDto([]);
      }

      const companyName = this.deriveCompanyName(companySlug, feed.title, buildId);
      this.collect(feed.jobs, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Avionté total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Avionté scrape error for build ${buildId}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch and parse the build's RSS/XML job export. */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    buildId: string,
  ): Promise<AvionteFeed | null> {
    // Request the extended XML variant — it is a superset of the base RSS feed,
    // carrying the description / posted-date / employment-type fields too.
    const url =
      `${AVIONTE_FEED_ORIGIN}${AVIONTE_RSS_PATH}` +
      `?compid=${encodeURIComponent(buildId)}&${AVIONTE_XML_FORMAT_QUERY}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const xml = typeof response.data === 'string' ? response.data : '';
      if (!xml || !/<item\b/i.test(xml)) {
        this.logger.warn(`Avionté feed for build "${buildId}" returned no parseable items`);
        return null;
      }
      return this.parseFeed(xml);
    } catch (err: any) {
      // An unknown build / disabled feed returns HTTP 404 (or other 4xx);
      // treat that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Avionté feed for build "${buildId}" not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Parse RSS/XML into a normalised feed (jobs with decoded fields). */
  private parseFeed(xml: string): AvionteFeed {
    const jobs: AvionteJob[] = [];
    AVIONTE_ITEM_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AVIONTE_ITEM_REGEX.exec(xml)) !== null) {
      const block = match[1] ?? '';
      jobs.push({
        title: this.extractTag(block, 'title'),
        guid: this.extractTag(block, 'guid'),
        id: this.extractTag(block, 'jobid') ?? this.extractTag(block, 'id'),
        link: this.extractTag(block, 'link'),
        description: this.extractTag(block, 'description'),
        location:
          this.extractTag(block, 'location') ?? this.extractTag(block, 'joblocation'),
        city: this.extractTag(block, 'city'),
        state: this.extractTag(block, 'state'),
        country: this.extractTag(block, 'country'),
        category: this.extractTag(block, 'category'),
        employmentType:
          this.extractTag(block, 'employmenttype') ?? this.extractTag(block, 'jobtype'),
        pubDate: this.extractTag(block, 'pubDate'),
      });
    }
    // The channel-level title/link sit before the first <item>.
    const channelBlock = xml.split(/<item\b/i)[0] ?? xml;
    return {
      title: this.extractTag(channelBlock, 'title'),
      link: this.extractTag(channelBlock, 'link'),
      jobs,
    };
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: AvionteJob[],
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Avionté job "${job?.title}": ${err.message}`);
      }
    }
  }

  private processJob(
    job: AvionteJob,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = this.cleanText(job.title);
    if (!title) return null;

    const jobUrl = this.buildJobUrl(job);
    if (!jobUrl) return null;

    const atsId = this.extractAtsId(job, jobUrl);
    if (!atsId) return null;

    const rawHtml = job.description ?? null;
    const description = this.formatDescription(rawHtml, format);

    return new JobPostDto({
      id: `avionte-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.pubDate ?? job.pubdate),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.AVIONTE,
      atsId,
      atsType: 'avionte',
      department: this.cleanText(job.category),
      employmentType: this.cleanText(job.employmentType ?? job.employmenttype),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The extended XML
   * `<description>` is an HTML-encoded body (entities decoded during parse); we
   * surface it as HTML, Markdown, or plain text on request, defaulting to plain
   * text. The base RSS feed carries no body, in which case this returns null.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the Avionté build id (the `compid`). An explicit `companySlug` is
   * used verbatim; a `companyUrl` is mined for a `compid` / `CompanyID` query,
   * falling back to the first sub-domain label of a `*.aviontego.com` portal
   * host. Returns an empty string when nothing usable is found.
   */
  private resolveBuildId(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      // A `?compid=` / `?CompanyID=` query is the most reliable signal.
      const q = companyUrl.match(AVIONTE_COMPID_REGEX);
      if (q && q[1]) {
        try {
          return decodeURIComponent(q[1]).trim();
        } catch {
          return q[1].trim();
        }
      }
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        // A branded portal host is `{build}.aviontego.com`: the first non-`www`
        // label is the build slug.
        if (hostname.endsWith(AVIONTE_PORTAL_DOMAIN)) {
          const labels = hostname.split('.').filter(Boolean);
          const first = labels[0];
          if (first && first !== 'www') return first;
        }
        // Otherwise (e.g. a bare feed host) there is nothing else to recover.
        void AVIONTE_FEED_DOMAIN;
      } catch {
        // Malformed URL — no build recoverable.
      }
    }
    return '';
  }

  /** Build the public apply / job-detail URL from the item's `<link>`. */
  private buildJobUrl(job: AvionteJob): string | null {
    const link = job.link ?? job.url;
    if (typeof link === 'string' && link.trim()) {
      const trimmed = link.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
    }
    return null;
  }

  /** Resolve the stable per-job ATS id from `<guid>` / id element, else the link. */
  private extractAtsId(job: AvionteJob, jobUrl: string): string | null {
    const explicit = this.cleanText(job.guid) ?? this.cleanText(job.id);
    if (explicit) {
      // A guid may itself be a URL; mine the id token out of it when so.
      const fromGuid = this.idFromUrl(explicit);
      return fromGuid ?? explicit;
    }
    return this.idFromUrl(jobUrl);
  }

  /** Mine a numeric / token job id out of a URL (e.g. `?JobId=12345`). */
  private idFromUrl(value: string): string | null {
    const m = value.match(AVIONTE_JOB_ID_REGEX);
    if (m) {
      const id = m[1] ?? m[2];
      if (id) {
        try {
          return decodeURIComponent(id).trim() || null;
        } catch {
          return id.trim() || null;
        }
      }
    }
    return null;
  }

  /**
   * Derive a display company name from the explicit slug, the channel `<title>`
   * (which Avionté sets to the build / company name), or the build id.
   */
  private deriveCompanyName(
    companySlug: string | undefined,
    channelTitle: string | null | undefined,
    buildId: string,
  ): string {
    const channel = this.cleanText(channelTitle);
    if (channel) return channel;
    const base = (companySlug && companySlug.trim() ? companySlug.trim() : buildId) || buildId;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Build a `LocationDto` from the structured `<city>` / `<state>` /
   * `<country>` fields (extended XML) or from the free-text `<location>` label
   * ("City, State[, Country]") in the base feed. Returns null when nothing
   * usable is present.
   */
  private extractLocation(job: AvionteJob): LocationDto | null {
    let city = this.cleanText(job.city);
    let state = this.cleanText(job.state);
    let country = this.cleanText(job.country);

    if (!city && !state && !country) {
      const label = this.cleanText(job.location);
      if (label) {
        const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
        city = parts[0] ?? null;
        state = parts[1] ?? null;
        country = parts[2] ?? null;
      }
    }

    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, location, category, or description. */
  private detectRemote(job: AvionteJob): boolean {
    const haystacks: Array<string | null | undefined> = [
      job.title,
      job.location,
      job.city,
      job.state,
      job.category,
      job.employmentType,
      job.description,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (AVIONTE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Parse an RFC-822 / ISO-8601 string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }

  /** Extract and decode the inner text of the first matching child element. */
  private extractTag(block: string, tag: string): string | null {
    const re = new RegExp(AVIONTE_TAG_REGEX_TEMPLATE.replace(/\{tag\}/g, tag), 'i');
    const m = block.match(re);
    if (!m) return null;
    return this.cleanValue(m[1]);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /** Strip CDATA wrappers and decode the common XML/HTML entities. */
  private cleanValue(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    let v = raw.trim();
    const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) v = cdata[1];
    v = this.decodeEntities(v).trim();
    return v || null;
  }

  /**
   * Decode the XML/HTML entities the feed emits. An extended-XML body is
   * double-encoded (e.g. `&lt;b&gt;` for bold), so a single pass yields the
   * inner HTML which we then hand to the description formatter.
   */
  private decodeEntities(input: string): string {
    return input
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => {
        const code = Number(d);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&amp;/g, '&');
  }
}
