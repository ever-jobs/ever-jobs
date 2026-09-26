import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  Site, looksLikeChallenge,
} from '@ever-jobs/models';
import { createHttpClient, randomSleep } from '@ever-jobs/common';
import {
  BAYT_DEFAULT_COUNTRY_PATH,
  BAYT_DEFAULT_RESULTS,
  BAYT_DELAY_MAX_MS,
  BAYT_DELAY_MIN_MS,
  BAYT_HEADERS,
  BaytScrapeOptions,
  resolveBaytOptions,
} from './bayt.constants';
import {
  baytFetchDiagnostics,
  buildSearchUrl,
  legacyBaytSlug,
  parseListing,
  resolveCountryPath,
  toBaytSlug,
  toJobPost,
} from './bayt.parse';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Bayt (bayt.com) - regional board for the Gulf, Levant and North Africa
 * (Spec 1710).
 *
 * Fetches the server-rendered search listing one page at a time, dedupes job
 * ids across pages and stops on the first page that adds nothing new, a page
 * with no cards, the wanted count, or the page cap. The site answers our
 * network with a bot challenge; that is reported as `blocked` - never as an
 * empty board - and no attempt is made to get past it.
 */
@SourcePlugin({
  site: Site.BAYT,
  name: 'Bayt',
  category: 'regional',
  // No `requiresSearchTerm` (Spec 1720): since Spec 1710 an empty term lists the
  // market's `/en/<market>/jobs/` page, so list mode calls Bayt.
})
@Injectable()
export class BaytService implements IScraper {
  private readonly logger = new Logger(BaytService.name);

  async scrape(
    input: ScraperInputDto,
    overrides: Partial<BaytScrapeOptions> = {},
  ): Promise<JobResponseDto> {
    const options = resolveBaytOptions(overrides);
    const resultsWanted = input.resultsWanted ?? BAYT_DEFAULT_RESULTS;
    const offset =
      Number.isFinite(input.offset) && (input.offset as number) > 0
        ? Math.floor(input.offset as number)
        : 0;
    const maxAgeMs =
      Number.isFinite(input.hoursOld) && (input.hoursOld as number) > 0
        ? (input.hoursOld as number) * HOUR_MS
        : null;

    const term = typeof input.searchTerm === 'string' ? input.searchTerm : '';
    const slug = options.legacySlug ? legacyBaytSlug(term) : toBaytSlug(term);
    if (term.trim() && !slug) {
      this.logger.warn(`Bayt search term "${term.slice(0, 80)}" has no usable slug; not searching`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics(
          'bad_input',
          'search term has no ASCII letters or digits after slug normalisation',
        ),
      );
    }
    const countryPath = options.countryScope
      ? resolveCountryPath(input)
      : BAYT_DEFAULT_COUNTRY_PATH;
    try {
      // Every page shares this path; a robots-disallowed or malformed one is refused up front.
      buildSearchUrl(countryPath, slug, 1);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Bayt: ${detail}; not searching`);
      return new JobResponseDto([], new ScrapeDiagnostics('bad_input', detail));
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout,
      userAgent: input.userAgent,
    });
    client.setHeaders({ ...BAYT_HEADERS });

    const jobList: JobPostDto[] = [];
    const seen = new Set<string>();
    const nowMs = Date.now();
    let skipped = 0;
    let diagnostics: ScrapeDiagnostics | undefined;

    for (let page = 1; page <= options.maxPages && jobList.length < resultsWanted; page++) {
      if (page > 1) await randomSleep(BAYT_DELAY_MIN_MS, BAYT_DELAY_MAX_MS);
      this.logger.log(`Fetching Bayt jobs page ${page} (/en/${countryPath}/)`);

      let html: string;
      try {
        const response = await client.get<string>(buildSearchUrl(countryPath, slug, page));
        html = typeof response.data === 'string' ? response.data : '';
      } catch (err: unknown) {
        diagnostics = baytFetchDiagnostics(err);
        this.logger.error(
          `Bayt scrape error on page ${page}: ${diagnostics.reason}` +
            (diagnostics.detail ? ` - ${diagnostics.detail}` : ''),
        );
        break;
      }

      const listing = parseListing(html);
      if (listing.cards === 0) {
        if (looksLikeChallenge(html)) {
          diagnostics = new ScrapeDiagnostics(
            'blocked',
            'bayt.com served a bot challenge page with HTTP 200',
          );
          this.logger.warn(`Bayt page ${page} is a bot challenge, not a listing`);
        } else {
          this.logger.log('No more Bayt job results');
        }
        break;
      }
      if (listing.jobs.length === 0) {
        diagnostics = new ScrapeDiagnostics(
          'unknown',
          `${listing.cards} cards on page ${page}, none parsed: listing markup changed?`,
        );
        this.logger.warn(`Bayt page ${page}: ${diagnostics.detail}`);
        break;
      }
      if (listing.failed > 0) {
        this.logger.debug(`Bayt page ${page}: skipped ${listing.failed} unparseable card(s)`);
      }

      let fresh = 0;
      for (const card of listing.jobs) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        fresh++;
        if (maxAgeMs !== null && card.postedAgeMs !== null && card.postedAgeMs > maxAgeMs) {
          continue;
        }
        if (skipped < offset) {
          skipped++;
          continue;
        }
        if (jobList.length < resultsWanted) {
          jobList.push(toJobPost(card, nowMs, { legacyMapping: options.legacyMapping }));
        }
      }

      if (fresh === 0) {
        this.logger.log(`Bayt page ${page} added no new jobs; stopping`);
        break;
      }
    }

    return new JobResponseDto(jobList, diagnostics);
  }
}
