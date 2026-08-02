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
  CONNEXYS_ROOT_DOMAIN,
  CONNEXYS_DEFAULT_RESULTS,
  CONNEXYS_DEFAULT_TIMEOUT_SECONDS,
  CONNEXYS_HEADERS,
  CONNEXYS_VACANCY_REGEX,
  CONNEXYS_REMOTE_REGEX,
  CONNEXYS_PUB_ID_PARAM,
  connexysFeedUrl,
} from './connexys.constants';
import { ConnexysJob, ConnexysVacancy } from './connexys.types';

/**
 * Connexys ATS careers scraper — generic, multi-tenant.
 *
 * Connexys (connexys.com — a Dutch ATS, now "Bullhorn Connexys" on the Salesforce platform)
 * lets every customer tenant publish its open roles to a branded, public, candidate-facing
 * career site. For each publication channel, the tenant's Connexys-hosted site exposes a
 * **public, anonymous XML vacancy feed** that downstream career websites consume directly:
 *
 *   GET https://www.connexys.nl/{site}public/run/xml_feed.startup?p_pub_id={channelId}
 *     → <vacancies><vacancy id="…"><titel/><plaats/><omschrijving/><url/>…</vacancy>…</vacancies>
 *
 * The feed lists every currently-published role for the channel in one document (no server-side
 * pagination), so the adapter fetches once and slices client-side to honour `resultsWanted`,
 * mapping each `<vacancy>` to a JobPostDto. Each role's `id` is the stable ATS id and its
 * `<url>` is the canonical public detail / apply page (the `<sollicitatie_url>` is the apply
 * form when distinct).
 *
 * The caller addresses a tenant by `companySlug` (the Connexys site name, optionally suffixed
 * with `#{channelId}` to pin a publication channel) or by `companyUrl` (a Connexys career-host
 * feed / site URL from which the site name + channel id are recovered). An unknown site, an
 * empty channel, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run. A transport-level failure (host
 * unreachable) stops the sweep; an HTTP error status degrades to no roles. Dedup is by ATS id.
 */
@SourcePlugin({
  site: Site.CONNEXYS,
  name: 'Connexys',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ConnexysService implements IScraper {
  private readonly logger = new Logger(ConnexysService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Connexys scraper');
      return new JobResponseDto([]);
    }

    const resolved = this.resolveTenant(companySlug, input.companyUrl);
    if (!resolved.site) {
      this.logger.warn('Could not resolve a Connexys tenant site from input');
      return new JobResponseDto([]);
    }
    const { site, channelId } = resolved;

    // Cap the per-request timeout so an unresponsive Connexys host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? CONNEXYS_DEFAULT_TIMEOUT_SECONDS,
      CONNEXYS_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(CONNEXYS_HEADERS);

    const resultsWanted = input.resultsWanted ?? CONNEXYS_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Connexys jobs for site: ${site}`);

      // The feed returns every currently-published role for the channel in one document.
      const result = await this.fetchFeed(client, site, channelId);
      if (!result.hostReachable) {
        this.logger.warn(`Connexys feed host unreachable for site ${site}`);
        return new JobResponseDto(jobPosts);
      }
      const xml = result.xml;
      const vacancies = xml ? this.parseVacancies(xml) : [];

      const companyName = this.deriveCompanyName(site);
      for (const vacancy of vacancies) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processVacancy(vacancy, site, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Connexys role ${vacancy?.id}: ${err.message}`);
        }
      }

      this.logger.log(`Connexys total: ${jobPosts.length} jobs for ${site}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Connexys scrape error for ${site}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * GET the tenant's public vacancy-feed XML. Returns `{ xml, hostReachable }`:
   *  - `xml` is the raw feed body, or null when the response carried no usable XML / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host with nothing to drain).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused /
   *    reset / timeout), where the host itself is unreachable.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchFeed(
    client: ReturnType<typeof createHttpClient>,
    site: string,
    channelId: string | null,
  ): Promise<{ xml: string | null; hostReachable: boolean }> {
    const url = connexysFeedUrl(site, channelId);
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const data = typeof response.data === 'string' ? response.data : '';
      if (!data || !/<vacancy\b/i.test(data)) {
        this.logger.warn(`Connexys feed for "${site}" returned no vacancies`);
        return { xml: null, hostReachable: true };
      }
      return { xml: data, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is nothing
        // to drain (unknown site / empty channel / server error).
        this.logger.warn(`Connexys feed returned HTTP ${status} for site ${site}`);
        return { xml: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host
      // is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Connexys feed fetch failed for site ${site}: ${err?.message ?? err}`);
      return { xml: null, hostReachable: false };
    }
  }

  /**
   * Parse the `<vacancies>` XML into structured vacancy objects. Hand-rolled, tolerant regex
   * parsing — the feed is a flat, predictable structure and any unparseable block is skipped,
   * never thrown.
   */
  private parseVacancies(xml: string): ConnexysVacancy[] {
    const out: ConnexysVacancy[] = [];
    const re = new RegExp(CONNEXYS_VACANCY_REGEX.source, CONNEXYS_VACANCY_REGEX.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      try {
        const attrs = m[1] ?? '';
        const body = m[2] ?? '';
        out.push({
          id: this.attr(attrs, 'id') ?? this.tag(body, 'id') ?? this.tag(body, 'vacancy_id'),
          titel: this.tag(body, 'titel'),
          title: this.tag(body, 'title') ?? this.tag(body, 'functietitel'),
          plaats: this.tag(body, 'plaats') ?? this.tag(body, 'standplaats'),
          city: this.tag(body, 'city') ?? this.tag(body, 'location'),
          regio: this.tag(body, 'regio') ?? this.tag(body, 'provincie'),
          region: this.tag(body, 'region'),
          land: this.tag(body, 'land'),
          country: this.tag(body, 'country'),
          omschrijving: this.tag(body, 'omschrijving'),
          description: this.tag(body, 'description'),
          functiegroep: this.tag(body, 'functiegroep') ?? this.tag(body, 'categorie'),
          department: this.tag(body, 'department'),
          dienstverband: this.tag(body, 'dienstverband') ?? this.tag(body, 'contract'),
          employmentType: this.tag(body, 'employmenttype'),
          uren: this.tag(body, 'uren'),
          hours: this.tag(body, 'hours'),
          publicatiedatum: this.tag(body, 'publicatiedatum') ?? this.tag(body, 'datum'),
          datePosted: this.tag(body, 'date') ?? this.tag(body, 'publishdate'),
          url: this.tag(body, 'url') ?? this.tag(body, 'vacature_url'),
          link: this.tag(body, 'link'),
          sollicitatie_url: this.tag(body, 'sollicitatie_url'),
          applyUrl: this.tag(body, 'apply_url'),
          publicatie_id: this.tag(body, 'publicatie_id'),
        });
      } catch (err: any) {
        this.logger.warn(`Error parsing a Connexys vacancy block: ${err.message}`);
      }
    }
    return out;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processVacancy(
    vacancy: ConnexysVacancy,
    site: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normalise(vacancy, site, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, site, format);
  }

  /** Build a normalised ConnexysJob from a parsed role, resolving every tag alias. */
  private normalise(vacancy: ConnexysVacancy, site: string, companyName: string): ConnexysJob | null {
    const atsId = this.cleanText(this.toStringId(vacancy.id));
    if (!atsId) return null;

    const url = this.value(vacancy.url, vacancy.link);
    if (!url || !/^https?:\/\//i.test(url)) return null;

    const apply = this.value(vacancy.sollicitatie_url, vacancy.applyUrl);
    const city = this.value(vacancy.plaats, vacancy.city);
    const state = this.value(vacancy.regio, vacancy.region);
    const country = this.value(vacancy.land, vacancy.country);
    const title = this.value(vacancy.titel, vacancy.title);
    const department = this.value(vacancy.functiegroep, vacancy.department);
    const employmentType = this.value(vacancy.dienstverband, vacancy.employmentType);
    const locationText = this.joinLocation(city, state, country);

    return {
      atsId,
      url,
      applyUrl: apply && /^https?:\/\//i.test(apply) ? apply : url,
      title,
      companyName,
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.value(vacancy.omschrijving, vacancy.description),
      department,
      employmentType,
      datePosted: this.parseDate(this.value(vacancy.publicatiedatum, vacancy.datePosted)),
      isRemote: this.detectRemote(title, locationText, department),
    };
  }

  /** Map a normalised ConnexysJob → JobPostDto. */
  private processJob(job: ConnexysJob, site: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(site);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `connexys-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.CONNEXYS,
      atsId,
      atsType: 'connexys',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Connexys exposes the body as
   * HTML (usually in a CDATA block), so HTML returns it as-is, Markdown converts it, and Plain
   * strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the Connexys tenant from input. The site name comes from an explicit `companySlug`
   * (optionally suffixed `#{channelId}` to pin a publication channel) or from a `companyUrl` on
   * a Connexys career host. A `companyUrl` may also carry the channel id in its `p_pub_id`
   * query. Returns `{ site, channelId }`; `site` is empty when nothing usable is present.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): { site: string; channelId: string | null } {
    if (companySlug && companySlug.trim()) {
      const raw = companySlug.trim();
      // A caller may pass a full feed / career URL as the slug.
      if (/^https?:\/\//i.test(raw) || raw.includes(CONNEXYS_ROOT_DOMAIN + '/')) {
        const fromUrl = this.tenantFromUrl(raw);
        if (fromUrl.site) return fromUrl;
      }
      // Otherwise it is a bare site name, optionally `site#channelId`.
      const [sitePart, channelPart] = raw.split('#');
      const site = this.normaliseSite(sitePart);
      const channelId = this.cleanText(channelPart) ?? null;
      if (site) return { site, channelId };
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl.site) return fromUrl;
    }
    return { site: '', channelId: null };
  }

  /**
   * Recover `{ site, channelId }` from a Connexys career / feed URL. The site name is the
   * leading `{site}public` path label on the career host; the channel id is the URL's
   * `p_pub_id` query when present.
   */
  private tenantFromUrl(value: string): { site: string; channelId: string | null } {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(CONNEXYS_ROOT_DOMAIN)) return { site: '', channelId: null };

      const channelId = this.cleanText(u.searchParams.get(CONNEXYS_PUB_ID_PARAM)) ?? null;
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      // The first path segment is `{site}public` (the site name glued to the `public` literal).
      const first = segments[0] ? decodeURIComponent(segments[0]) : '';
      const site = this.normaliseSite(first.replace(/public$/i, ''));
      if (site) return { site, channelId };
      return { site: '', channelId };
    } catch {
      // Malformed URL — no tenant recoverable.
    }
    return { site: '', channelId: null };
  }

  /** Lower-case + strip stray separators / the trailing `public` literal from a site token. */
  private normaliseSite(value: string | null | undefined): string {
    const cleaned = this.cleanText(value);
    if (!cleaned) return '';
    return cleaned.replace(/public$/i, '').replace(/[\s/]+/g, '').toLowerCase();
  }

  /** De-slugify + title-case the site token into a display company name. */
  private deriveCompanyName(site: string): string {
    const base = site && site.trim() ? site.trim() : site;
    return base
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: ConnexysJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Join the structured location parts into a single free-text line (for remote detection). */
  private joinLocation(
    city: string | null,
    state: string | null,
    country: string | null,
  ): string | null {
    const parts = [city, state, country].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Detect remote roles from the title, location, or function-group text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    department: string | null,
  ): boolean {
    const haystacks: Array<string | null> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (CONNEXYS_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Parse a date value into a YYYY-MM-DD string. Non-absolute / unparseable values yield null. */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    // Accept European `dd-mm-yyyy` by reordering before Date parsing.
    const eu = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    const candidate = eu ? `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}` : cleaned;
    try {
      const parsed = new Date(candidate);
      if (!isNaN(parsed.getTime())) return toDateOnly(candidate);
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Extract a single XML attribute value from an element's attribute string. Returns null when
   * the attribute is absent or empty.
   */
  private attr(attrs: string, name: string): string | null {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
    const v = m && typeof m[1] === 'string' ? m[1].trim() : '';
    return v ? this.decodeEntities(v) : null;
  }

  /**
   * Extract a single child element's text content, transparently unwrapping a `<![CDATA[…]]>`
   * wrapper and decoding XML entities. Returns null when the element is absent or empty.
   */
  private tag(body: string, name: string): string | null {
    const m = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (!m || typeof m[1] !== 'string') return null;
    let raw = m[1].trim();
    const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) raw = cdata[1];
    raw = raw.trim();
    if (!raw) return null;
    // Only decode entities for non-HTML bodies; HTML descriptions keep their markup intact.
    return /[<>]/.test(raw) ? raw : this.decodeEntities(raw);
  }

  /** Decode the handful of XML entities the feed uses. */
  private decodeEntities(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** Coerce a numeric-or-string id into a string, else null. */
  private toStringId(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') return value;
    return null;
  }

  /** First non-empty trimmed string among the supplied aliases, else null. */
  private value(...candidates: Array<string | null | undefined>): string | null {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
