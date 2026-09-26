import { CompensationDto } from '@ever-jobs/models';

/** The two listing streams the board serves. Matches the card's `employment_type` attribute. */
export type InternshalaKind = 'job' | 'internship';

/**
 * How a stream builds its listing path.
 *
 * - `narrow`: the site's city / work-from-home path forms (fewer pages, but a
 *   form the site may not route — see the canonical guard);
 * - `keyword`: `/…/keywords-{kw}/` (verified) plus the client-side filters.
 */
export type InternshalaStrategy = 'narrow' | 'keyword';

/** Which streams a search runs when the caller does not name a `jobType`. */
export type InternshalaStreamsSetting = 'both' | InternshalaKind;

/** Id scheme: the site's own posting id (default) or the pre-Spec-1706 hash of the job URL. */
export type InternshalaIdScheme = 'posting' | 'url-hash';

/** Process-wide switches, read from the environment on every scrape. */
export interface InternshalaOptions {
  /** Streams for a search with no `jobType`. `job` restores the pre-Spec-1706 default. */
  defaultStreams: InternshalaStreamsSetting;
  /** `url-hash` restores the pre-Spec-1706 `is-<hash(jobUrl)>` ids. */
  idScheme: InternshalaIdScheme;
  /** Hard cap on listing requests per stream. */
  maxPages: number;
  /** Use the detail slug's trailing epoch to refine the posted date (guarded). */
  slugTimestamp: boolean;
}

/** Age bucket of a relative "posted" label, in hours. */
export interface PostedAge {
  /** Youngest the posting can be. */
  lowerH: number;
  /** Width of the bucket: the posting is at most `lowerH + widthH` hours old. */
  widthH: number;
}

/** What a listing search asks the site for (already cleaned and slugified). */
export interface ListingQuery {
  /** Search term with robots-unsafe characters removed; `''` when none. */
  term: string;
  /** Site slug of the requested city, or `null`. */
  city: string | null;
  /** Work-from-home only. */
  remote: boolean;
}

/** Filters applied to every parsed card, whatever path fetched it. */
export interface CardFilters {
  /** Keep only work-from-home cards. */
  remote: boolean;
  /** Slugified city names that count as the requested city (input + aliases), or `null`. */
  cityKeys: string[] | null;
  /** `only` keeps "Part time" cards, `exclude` drops them. */
  partTime: 'only' | 'exclude' | null;
  /** Drop cards whose posted-age lower bound exceeds this many hours. */
  maxAgeHours: number | null;
}

/** Description depth keys shared with other source plugins. */
export type InternshalaDescriptionDepth = 'board' | 'detail-25' | 'detail-all';

/** Everything `scrape()` needs to know before its first request. */
export interface SearchPlan {
  /** Streams in fetch order (internship first). Empty when `unsupportedJobType` is set. */
  kinds: InternshalaKind[];
  query: ListingQuery;
  /** Strategy each stream starts with. */
  strategy: InternshalaStrategy;
  filters: CardFilters;
  resultsWanted: number;
  offset: number;
  /** `offset + resultsWanted`: accepted postings to collect before stopping. */
  need: number;
  depth: InternshalaDescriptionDepth;
  /** Detail requests allowed (`0` for `board`). */
  detailBudget: number;
  /** Set when the caller's `jobType` has no equivalent on this board. */
  unsupportedJobType: string | null;
}

/** One listing card, parsed. Pure data: no DTOs except the compensation. */
export interface ParsedCard {
  /** The site's posting id (`internshipId` attribute), or `null` when absent. */
  internshipId: string | null;
  kind: InternshalaKind;
  title: string;
  /** `/job/detail/…` or `/internship/detail/…`, query and fragment stripped. */
  path: string;
  jobUrl: string;
  companyName: string | null;
  companyLogo: string | null;
  /** City labels, split on commas, work-from-home labels removed. */
  locationLabels: string[];
  remote: boolean;
  hybrid: boolean;
  /** Raw pay text as shown (the period-bearing variant for jobs). */
  payText: string | null;
  compensation: CompensationDto | null;
  duration: string | null;
  experience: string | null;
  /** Plain-text responsibilities snippet from the card. */
  snippet: string | null;
  skills: string[];
  postedLabel: string | null;
  postedAge: PostedAge | null;
  statusLabels: string[];
  /** Post-internship offer label (never the pay). */
  ppoText: string | null;
  /**
   * Application deadline text, when the card shows one (the card layout the
   * pre-Spec-1706 parser read carried it; today's cards usually do not).
   */
  applyBy?: string | null;
  partTime: boolean;
  international: boolean;
}

/** A card the parser refused, with the reason (the service logs it). */
export interface SkippedCard {
  index: number;
  reason: string;
}

/** One listing page, parsed. */
export interface ParsedListingPage {
  cards: ParsedCard[];
  /** Raw number of card containers on the page (parsed + skipped). */
  cardCount: number;
  skipped: SkippedCard[];
  /** `input#isLastPage`: `true` for `1`, `false` for `0`, `null` when absent. */
  isLastPage: boolean | null;
  /** Highest `a.pagination_block[data-page]`, or `null`. */
  maxPage: number | null;
  /** Normalised `link[rel=canonical]` path, or `null`. */
  canonicalPath: string | null;
  /** The page has no cards and looks like a bot-challenge interstitial. */
  looksBlocked: boolean;
}
