import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownToPlainText,
  markdownConverter,
  extractEmails,
  parseLocationList,
  toDateOnly,
  firstPublicUrl,
} from '@ever-jobs/common';
import {
  RELIEFWEB_PUBLIC_NODE_URL,
  RELIEFWEB_API_URL,
  RELIEFWEB_APP_NAME,
  RELIEFWEB_APP_NAME_ENV,
  RELIEFWEB_APP_NAME_DOCS_URL,
  RELIEFWEB_HEADERS,
  RELIEFWEB_DEFAULT_RESULTS,
  RELIEFWEB_MAX_RESULTS,
  RELIEFWEB_FIELDS,
} from './reliefweb.constants';
import { ReliefWebResponse, ReliefWebJobEntry, ReliefWebErrorBody } from './reliefweb.types';

/**
 * ReliefWeb jobs through the public API v2 (Spec 1752; v1 answers 410).
 *
 * ReliefWeb serves only pre-approved `appname`s (since 1 November 2025). The
 * appname comes from `RELIEFWEB_APPNAME`, else the neutral `ever-jobs`; an
 * unapproved one is answered 403, which this plugin reports as a `bad_input`
 * diagnostic naming the variable to set rather than as a block.
 */
@SourcePlugin({
  site: Site.RELIEFWEB,
  name: 'ReliefWeb',
  category: 'niche',
})
@Injectable()
export class ReliefWebService implements IScraper {
  private readonly logger = new Logger(ReliefWebService.name);

  constructor() {
    if (!process.env[RELIEFWEB_APP_NAME_ENV]?.trim()) {
      this.logger.warn(
        `${RELIEFWEB_APP_NAME_ENV} not set: using "${RELIEFWEB_APP_NAME}", which ReliefWeb answers with 403 ` +
          `unless it has approved it. Request an appname at ${RELIEFWEB_APP_NAME_DOCS_URL}`,
      );
    }
  }

  /** The configured appname (`RELIEFWEB_APPNAME`), else the neutral default. Read per scrape. */
  private appName(): string {
    const configured = process.env[RELIEFWEB_APP_NAME_ENV]?.trim();
    return configured || RELIEFWEB_APP_NAME;
  }

  /**
   * The actionable diagnostic for ReliefWeb's "not an approved appname" 403,
   * or null for any other failure. The appname is a public identifier (it is
   * sent in the query string), not a secret.
   */
  private unapprovedAppName(err: any, appName: string): ScrapeDiagnostics | null {
    if (err?.response?.status !== 403) return null;
    const body = err.response.data as ReliefWebErrorBody | string | undefined;
    const message = typeof body === 'string' ? body : body?.error?.message ?? '';
    if (!/appname/i.test(message)) return null;
    return new ScrapeDiagnostics(
      'bad_input',
      `ReliefWeb rejected appname "${appName}" (HTTP 403: ${message.slice(0, 160)}). ` +
        `Set ${RELIEFWEB_APP_NAME_ENV} to a pre-approved appname — request one at ${RELIEFWEB_APP_NAME_DOCS_URL}`,
    );
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = Math.min(
      input.resultsWanted ?? RELIEFWEB_DEFAULT_RESULTS,
      RELIEFWEB_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(RELIEFWEB_HEADERS);

    const appName = this.appName();
    const params = new URLSearchParams({
      appname: appName,
      limit: String(resultsWanted),
      offset: '0',
    });

    for (const field of RELIEFWEB_FIELDS) {
      params.append('fields[include][]', field);
    }

    if (input.searchTerm) {
      params.set('query[value]', input.searchTerm);
    }

    const url = `${RELIEFWEB_API_URL}?${params.toString()}`;

    this.logger.log(`Fetching ReliefWeb jobs: ${RELIEFWEB_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as ReliefWebResponse;

      const entries = data?.data ?? [];
      if (entries.length === 0) {
        this.logger.log('No ReliefWeb jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(`ReliefWeb returned ${entries.length} jobs`);

      const jobs: JobPostDto[] = [];

      for (const entry of entries) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping ReliefWeb job ${entry.id}: ${err.message}`);
        }
      }

      this.logger.log(`ReliefWeb returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      const appNameProblem = this.unapprovedAppName(err, appName);
      if (appNameProblem) {
        this.logger.error(appNameProblem.detail ?? 'ReliefWeb rejected the appname');
        return new JobResponseDto([], appNameProblem);
      }
      this.logger.error(`ReliefWeb scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private mapJob(entry: ReliefWebJobEntry, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    const fields = entry.fields;
    if (!fields.title) return null;

    // Spec 1751/1752: `entry.href` is the API resource
    // (`https://api.reliefweb.int/v2/jobs/<id>`) — never a link. Prefer the
    // friendly page (`url_alias`, the page's own rel=canonical), then the
    // canonical `url`; with neither, the public node page (301s to the alias).
    const jobUrl =
      firstPublicUrl(fields.url_alias, fields.url) ??
      `${RELIEFWEB_PUBLIC_NODE_URL}/${encodeURIComponent(entry.id)}`;

    // v2 `body` is Markdown and `body-html` its HTML: serve each format from
    // the matching field. With no format requested, `body` as before.
    const bodyHtml = fields['body-html'] ?? null;
    let description: string | null = fields.body ?? null;
    if (descriptionFormat === DescriptionFormat.HTML) {
      description = bodyHtml ?? description;
    } else if (descriptionFormat === DescriptionFormat.PLAIN) {
      // The Markdown `body` needs its own conversion: htmlToPlainText would keep
      // its heading, emphasis and link markers (PR #100 review).
      description = bodyHtml
        ? htmlToPlainText(bodyHtml)
        : description
          ? markdownToPlainText(description)
          : null;
    } else if (description && descriptionFormat === DescriptionFormat.MARKDOWN) {
      if (/<[^>]+>/.test(description)) {
        description = markdownConverter(description) ?? description;
      }
    }

    const companyName = fields.source?.[0]?.name ?? null;

    const countries = fields.country?.map(c => c.name) ?? [];
    // each country name is a site-level country label — let the shared parser
    // emit per-country entries instead of cramming the list into `city`
    const parsedLocations = parseLocationList(countries);
    const location = parsedLocations.location;
    const locations = parsedLocations.locations;

    let datePosted: string | null = null;
    if (fields.date?.created) {
      try {
        datePosted = toDateOnly(fields.date.created);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `reliefweb-${entry.id}`,
      title: fields.title,
      companyName,
      jobUrl,
      location,
      ...(locations.length > 0 ? { locations } : {}),
      description,
      compensation: undefined,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.RELIEFWEB,
    });
  }
}
