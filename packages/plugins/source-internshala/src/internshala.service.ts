import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  looksLikeChallenge,
  refusalFromScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto,
  DescriptionFormat, Site,
} from '@ever-jobs/models';
import {
  HttpClient, createHttpClient, randomSleep,
} from '@ever-jobs/common';
import {
  INTERNSHALA_BAND_DELAY_SECONDS,
  INTERNSHALA_DEFAULT_USER_AGENT,
  INTERNSHALA_DELAY_SECONDS,
  INTERNSHALA_DETAIL_MAX_CONSECUTIVE_FAILURES,
  INTERNSHALA_HEADERS,
  INTERNSHALA_REDIRECT_HOSTS,
  INTERNSHALA_ROOT,
} from './internshala.constants';
import {
  buildListingPath,
  buildListingUrl,
  cardMatchesFilters,
  cardToJobPost,
  classifyCanonical,
  composeDescription,
  interleave,
  isRobotsSafeUrl,
  parseDetailDescription,
  parseListingPage,
  planSearch,
  resolveInternshalaOptions,
} from './internshala.parser';
import {
  InternshalaKind,
  InternshalaOptions,
  InternshalaStrategy,
  ParsedCard,
  SearchPlan,
} from './internshala.types';

/** One listing stream (internships or jobs) and how far it has got. */
interface ListingStream {
  kind: InternshalaKind;
  strategy: InternshalaStrategy;
  page: number;
  /** Listing requests made for this stream (the page cap counts these). */
  requests: number;
  exhausted: boolean;
  /** Accepted cards, in fetch order. */
  accepted: ParsedCard[];
}

/** Per-scrape mutable state shared by the helpers below. */
interface ScrapeState {
  requests: number;
  diagnostics?: ScrapeDiagnostics;
}

/**
 * Internshala (India): internships and fresher/entry-level jobs (Spec 1706).
 *
 * Listing pages are server-rendered HTML. A search runs one stream per kind
 * (internships first, then jobs), one page per stream per round, until enough
 * postings are accepted or every stream is exhausted, then fetches detail
 * pages for the first `descriptionDepth` postings. Every request is
 * sequential and 2-5 s apart; only robots.txt-allowed paths are requested.
 */
@SourcePlugin({
  site: Site.INTERNSHALA,
  name: 'Internshala',
  category: 'regional',
  description: 'India internships and fresher jobs; keyword, city and work-from-home search; INR pay',
})
@Injectable()
export class InternshalaService implements IScraper {
  private readonly logger = new Logger(InternshalaService.name);
  private readonly delay = INTERNSHALA_DELAY_SECONDS;
  private readonly bandDelay = INTERNSHALA_BAND_DELAY_SECONDS;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const options = resolveInternshalaOptions(process.env);
    const plan = planSearch(input, options);

    if (plan.unsupportedJobType) {
      this.logger.log(`Internshala: jobType=${plan.unsupportedJobType} has no equivalent; no request made`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics(
          'empty',
          `internshala lists internships and full/part-time jobs only; jobType=${plan.unsupportedJobType} has no equivalent`,
        ),
      );
    }

    const client = createHttpClient({
      ...input,
      userAgent: input.userAgent || INTERNSHALA_DEFAULT_USER_AGENT,
      allowedRedirectHosts: INTERNSHALA_REDIRECT_HOSTS,
    });
    client.setHeaders({ ...INTERNSHALA_HEADERS });

    this.logger.log(`Scraping Internshala for: "${plan.query.term}" (${plan.kinds.join(' + ')})`);

    const nowMs = Date.now();
    const state: ScrapeState = { requests: 0 };
    const streams: ListingStream[] = plan.kinds.map((kind) => ({
      kind,
      strategy: plan.strategy,
      page: 1,
      requests: 0,
      exhausted: false,
      accepted: [],
    }));
    const seen = new Set<string>();

    // One page per active stream per round, so a default search returns both kinds.
    let accepted = 0;
    while (accepted < plan.need && streams.some((s) => !s.exhausted)) {
      for (const stream of streams) {
        if (!stream.exhausted) {
          accepted += await this.fetchListingPage(client, stream, plan, options, seen, state);
        }
      }
    }

    const selected = interleave(streams.map((s) => s.accepted)).slice(plan.offset, plan.offset + plan.resultsWanted);
    const bodies = await this.fetchDescriptions(client, selected, plan, input.descriptionFormat, state);
    const jobs = selected.map((card, i) =>
      cardToJobPost(card, {
        nowMs,
        idScheme: options.idScheme,
        slugTimestamp: options.slugTimestamp,
        description: composeDescription(bodies[i] ?? card.snippet, card),
      }),
    );

    this.logger.log(`Internshala: found ${jobs.length} jobs/internships (${state.requests} requests)`);
    return new JobResponseDto(jobs, state.diagnostics);
  }

  /** Fetch and absorb the stream's next listing page; returns the number of cards accepted. */
  private async fetchListingPage(
    client: HttpClient,
    stream: ListingStream,
    plan: SearchPlan,
    options: InternshalaOptions,
    seen: Set<string>,
    state: ScrapeState,
  ): Promise<number> {
    const path = buildListingPath(stream.kind, plan.query, stream.strategy);
    const url = buildListingUrl(stream.kind, plan.query, stream.strategy, stream.page);
    this.logger.debug(`Fetching ${stream.kind} page ${stream.page}: ${url}`);

    await this.pause(state);
    state.requests++;
    stream.requests++;

    let resp: any;
    try {
      resp = await client.get(url);
    } catch (err: any) {
      const status = err?.response?.status;
      const gone = status === 404 || status === 410;
      if (gone && stream.page > 1) {
        // A page past the end of the results, not a failure.
        this.logger.debug(`Internshala: ${url} returned ${status}; end of the ${stream.kind} results`);
        stream.exhausted = true;
        return 0;
      }
      if (gone && stream.strategy === 'narrow') {
        this.logger.warn(`Internshala: ${url} returned ${status}; switching the ${stream.kind} stream to the keyword search`);
        this.switchToKeyword(stream, options);
        return 0;
      }
      this.logger.warn(`Internshala ${stream.kind} listing error on page ${stream.page}: ${err?.message ?? err}`);
      stream.exhausted = true;
      this.record(state, classifyScrapeError(err));
      return 0;
    }

    const html = typeof resp?.data === 'string' ? resp.data : String(resp?.data ?? '');
    const page = parseListingPage(html, stream.kind);
    for (const skip of page.skipped) {
      this.logger.warn(`Internshala: skipped card #${skip.index} on ${url}: ${skip.reason}`);
    }

    // Canonical guard: a filtered request answered with the unfiltered root lost its filter.
    const finalUrl: unknown = resp?.request?.res?.responseUrl;
    const verdicts = [
      classifyCanonical(path, page.canonicalPath),
      typeof finalUrl === 'string' ? classifyCanonical(path, finalUrl) : 'absent',
    ];
    if (verdicts.includes('dropped')) {
      const root = INTERNSHALA_ROOT[stream.kind];
      if (stream.page > 1) {
        // Page 1 was filtered; a later page answered with the root is past the end.
        this.logger.debug(`Internshala: ${url} was answered with ${root}; end of the ${stream.kind} results`);
        stream.exhausted = true;
        return 0;
      }
      if (stream.strategy === 'narrow') {
        this.logger.warn(`Internshala: ${path} was answered with ${root}; switching the ${stream.kind} stream to the keyword search`);
        this.switchToKeyword(stream, options);
        return 0;
      }
      this.logger.warn(`Internshala: ${path} was answered with ${root}; stopping the ${stream.kind} stream`);
      stream.exhausted = true;
      this.record(state, new ScrapeDiagnostics('fetch_error', `internshala dropped the search filter (redirected to ${root})`));
      return 0;
    }
    if (verdicts.includes('mismatch')) {
      this.logger.debug(`Internshala: canonical ${page.canonicalPath} differs from ${path}; accepted`);
    }

    if (page.cards.length === 0) {
      stream.exhausted = true;
      if (page.looksBlocked) {
        this.record(state, new ScrapeDiagnostics('blocked', `internshala answered ${url} with a challenge page`));
      }
      return 0;
    }

    let newIds = 0;
    let acceptedHere = 0;
    for (const card of page.cards) {
      const key = card.internshipId ?? card.jobUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      newIds++;
      if (cardMatchesFilters(card, plan.filters)) {
        stream.accepted.push(card);
        acceptedHere++;
      }
    }

    if (
      newIds === 0 ||
      page.isLastPage === true ||
      (page.maxPage !== null && stream.page >= page.maxPage) ||
      stream.requests >= options.maxPages
    ) {
      stream.exhausted = true;
    }
    stream.page++;
    return acceptedHere;
  }

  /** Detail bodies for the first `detailBudget` postings, sequentially; `null` keeps the snippet. */
  private async fetchDescriptions(
    client: HttpClient,
    cards: ParsedCard[],
    plan: SearchPlan,
    format: DescriptionFormat | undefined,
    state: ScrapeState,
  ): Promise<Array<string | null>> {
    const bodies: Array<string | null> = cards.map(() => null);
    const limit = Math.min(cards.length, plan.detailBudget);
    let consecutiveFailures = 0;
    for (let i = 0; i < limit; i++) {
      const { jobUrl } = cards[i];
      if (!isRobotsSafeUrl(jobUrl)) {
        this.logger.debug(`Internshala: not fetching a robots-disallowed detail URL: ${jobUrl}`);
        continue;
      }
      await this.pause(state);
      state.requests++;
      try {
        const resp = await client.get(jobUrl);
        const html = typeof resp?.data === 'string' ? resp.data : String(resp?.data ?? '');
        if (looksLikeChallenge(html)) {
          const blocked = new ScrapeDiagnostics('blocked', `challenge page instead of ${jobUrl}`);
          this.logger.warn(`Internshala: challenge page on a detail request; stopping detail requests`);
          this.record(state, blocked);
          break;
        }
        bodies[i] = parseDetailDescription(html, format);
        consecutiveFailures = 0;
      } catch (err: any) {
        this.logger.warn(`Error fetching description for ${jobUrl}: ${err?.message ?? err}`);
        // A refusal (403, 429, challenge) ends the walk: the rest of the
        // budget would only go to a host that has said stop.
        const refusal = refusalFromScrapeError(err);
        this.record(state, refusal ?? classifyScrapeError(err));
        if (refusal) {
          this.logger.warn(`Internshala refused a detail request (${refusal.reason}); stopping detail requests`);
          break;
        }
        consecutiveFailures++;
        if (consecutiveFailures >= INTERNSHALA_DETAIL_MAX_CONSECUTIVE_FAILURES) {
          this.logger.warn(`Internshala: ${consecutiveFailures} detail requests failed in a row; stopping detail requests`);
          break;
        }
      }
    }
    return bodies;
  }

  private switchToKeyword(stream: ListingStream, options: InternshalaOptions): void {
    stream.strategy = 'keyword';
    stream.page = 1;
    if (stream.requests >= options.maxPages) stream.exhausted = true;
  }

  /** Keep the first problem: it is the one that explains the result. */
  private record(state: ScrapeState, diagnostics: ScrapeDiagnostics): void {
    if (!state.diagnostics) state.diagnostics = diagnostics;
  }

  /** Sleep between requests (never before the first). */
  private async pause(state: ScrapeState): Promise<void> {
    if (state.requests > 0) {
      await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
    }
  }
}
