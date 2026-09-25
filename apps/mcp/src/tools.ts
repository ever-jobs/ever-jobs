/**
 * Ever Jobs MCP Server — Tool implementations
 *
 * These functions connect to the Ever Jobs REST API (or can be used standalone)
 * to search for jobs across 166+ sources.
 */

import axios, { AxiosInstance } from 'axios';

// ── Configuration ──────────────────────────────────────────────────────

const API_URL = process.env.EVER_JOBS_API_URL ?? 'http://localhost:3001';

/**
 * Which key spelling `searchJobs` uses in the `POST /api/jobs/search` body
 * (Spec 1689).
 *
 * The API validates the body against `ScraperInputDto` under a global
 * `ValidationPipe({ whitelist: true })`, and that DTO only declares camelCase
 * properties (`searchTerm`, `siteType`, `companySlug`, `resultsWanted`). The
 * legacy snake_case keys were therefore stripped before the handler ran, so an
 * MCP search went out with no search term, no source filter and the DTO's
 * default page size — i.e. a fan-out across the whole catalogue.
 *
 *  - `camel` (default) — the keys `ScraperInputDto` accepts.
 *  - `snake` — the legacy wire shape, kept for API servers that expect it.
 *  - `both`  — send both spellings (whitelisting servers drop the extra set).
 *
 * Unrecognised values fall back to `camel`.
 */
export type SearchRequestKeyStyle = 'camel' | 'snake' | 'both';

export const MCP_REQUEST_KEYS_ENV_VAR = 'EVER_JOBS_MCP_REQUEST_KEYS';

export function readSearchRequestKeyStyle(
  env: NodeJS.ProcessEnv = process.env,
): SearchRequestKeyStyle {
  const raw = env[MCP_REQUEST_KEYS_ENV_VAR]?.trim().toLowerCase();
  return raw === 'snake' || raw === 'both' ? raw : 'camel';
}

/**
 * How `JobResult.location` is rendered from the API's structured
 * `LocationDto` (Spec 1689).
 *
 *  - `full` (default) — `city, state, country` joined, falling back to the
 *    source's `name`, then its raw `text`, then `null`. Mirrors the CLI's
 *    CSV rendering (apps/cli/src/commands/search.command.ts).
 *  - `city` — the legacy output: the `city` field alone when there is one.
 *    Jobs without a city fall back to the `full` rendering, so the declared
 *    `string | null` contract holds (the old code returned the whole location
 *    object in that case).
 *
 * Unrecognised values fall back to `full`.
 */
export type LocationFormat = 'full' | 'city';

export const MCP_LOCATION_FORMAT_ENV_VAR = 'EVER_JOBS_MCP_LOCATION_FORMAT';

export function readLocationFormat(
  env: NodeJS.ProcessEnv = process.env,
): LocationFormat {
  const raw = env[MCP_LOCATION_FORMAT_ENV_VAR]?.trim().toLowerCase();
  return raw === 'city' ? 'city' : 'full';
}

function getClient(): AxiosInstance {
  return axios.create({
    baseURL: API_URL,
    timeout: 60_000,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Types ──────────────────────────────────────────────────────────────

export interface JobSearchParams {
  query: string;
  location?: string;
  source?: string;
  company?: string;
  limit?: number;
  remoteOnly?: boolean;
  /**
   * Per-request crawl policy (Spec 1690), forwarded to the API unchanged as the
   * camelCase `crawl` object (e.g. `{ maxConcurrentPerHost: 1, minIntervalMs: 1000 }`).
   * The API validates it and applies the operator's `EVER_JOBS_CRAWL_CALLER_OVERRIDES`.
   */
  crawl?: McpCrawlPolicy;
}

/** A crawl-policy object as the API's `crawl` field accepts it (camelCase keys). */
export type McpCrawlPolicy = Record<string, unknown>;

// ── Crawl policy (Spec 1690) ───────────────────────────────────────────
//
// The MCP server is packaged on its own (`apps/mcp`, rootDir `src`), so it
// cannot import `@ever-jobs/models`; the allowed values mirror
// `CRAWL_POLICY_DTO_VALUES` there. `apps/mcp/__tests__/crawl.spec.ts` fails if
// the two drift apart.

/** Allowed values of the enum-like crawl-policy fields. */
export const MCP_CRAWL_ENUMS = {
  userAgentMode: ['identify', 'strict', 'plugin'],
  proxyRotation: ['per-request', 'per-scrape', 'per-host', 'off'],
  rateLimitScope: ['host', 'domain', 'site'],
  retryBackoff: ['exponential', 'linear', 'constant'],
  retryAfterOverMax: ['give-up', 'cap'],
  robotsTxt: ['off', 'crawl-delay', 'respect'],
  discovery: ['auto', 'sitemap', 'listing'],
} as const;

const nonNegativeInt = (description: string) => ({ type: 'integer', minimum: 0, description });

/**
 * JSON Schema of the `crawl` argument of the `search_jobs` tool. Every field
 * is optional; the API is the authority on validation.
 */
export const CRAWL_POLICY_INPUT_SCHEMA = {
  type: 'object',
  description:
    'Optional per-request crawl policy (Spec 1690), sent to the API as `crawl` with camelCase keys, ' +
    'e.g. {"maxConcurrentPerHost":1,"minIntervalMs":1000,"discovery":"sitemap"}. ' +
    'The operator may restrict what a caller can change (EVER_JOBS_CRAWL_CALLER_OVERRIDES); ' +
    'the preset (EVER_JOBS_CRAWL_PRESET) is server-wide and cannot be chosen here.',
  additionalProperties: false,
  properties: {
    userAgent: { type: 'string', description: 'User-Agent to send (keywords: default, browser).' },
    userAgentMode: { type: 'string', enum: [...MCP_CRAWL_ENUMS.userAgentMode] },
    from: { type: 'string', description: 'From: request header (contact address).' },
    stripClientHints: { type: 'boolean' },
    proxyRotation: { type: 'string', enum: [...MCP_CRAWL_ENUMS.proxyRotation] },
    rateLimitScope: { type: 'string', enum: [...MCP_CRAWL_ENUMS.rateLimitScope] },
    maxConcurrentPerHost: nonNegativeInt('Max requests in flight per host/domain/site bucket. 0 = unlimited.'),
    minIntervalMs: nonNegativeInt('Minimum gap between request starts in a bucket, ms.'),
    jitterMs: nonNegativeInt('Random extra 0..jitterMs per gap, ms.'),
    maxQueueWaitMs: nonNegativeInt('Longest wait for a slot before failing fast, ms. 0 = no limit.'),
    adaptiveThrottle: { type: 'boolean' },
    retries: nonNegativeInt('Retries per request on a retryable status.'),
    retryStatuses: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 599 } },
    retryBackoff: { type: 'string', enum: [...MCP_CRAWL_ENUMS.retryBackoff] },
    retryBaseDelayMs: nonNegativeInt('Base retry delay, ms.'),
    retryMaxDelayMs: nonNegativeInt('Cap on one retry delay, ms.'),
    retryJitter: { type: 'boolean' },
    retryOnNetworkError: { type: 'boolean' },
    respectRetryAfter: { type: 'boolean' },
    maxRetryAfterMs: nonNegativeInt('A Retry-After longer than this triggers retryAfterOverMax, ms.'),
    retryAfterOverMax: { type: 'string', enum: [...MCP_CRAWL_ENUMS.retryAfterOverMax] },
    throttleRetryDelayMs: nonNegativeInt(
      'Back-off floor after a 429/503, ms: retry n waits at least this x 2^n; also the minimum host cool-down. 0 = no floor.',
    ),
    robotsTxt: { type: 'string', enum: [...MCP_CRAWL_ENUMS.robotsTxt] },
    blockPrivateNetworks: { type: 'boolean' },
    discovery: { type: 'string', enum: [...MCP_CRAWL_ENUMS.discovery] },
  },
} as const;

/**
 * Accept the tool's `crawl` argument as an object or as a JSON-object string
 * (some clients stringify nested arguments). Returns `undefined` when absent or
 * empty; throws on anything else so the tool reports the mistake instead of
 * silently searching with the server defaults.
 */
export function normalizeMcpCrawl(raw: unknown): McpCrawlPolicy | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('crawl must be an object (or a JSON object string)');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('crawl must be an object (or a JSON object string)');
  }
  return Object.keys(value as object).length > 0 ? { ...(value as McpCrawlPolicy) } : undefined;
}

export interface JobResult {
  id: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  description: string | null;
  date_posted: string | null;
  is_remote: boolean;
  source: string;
  salary: string | null;
  department: string | null;
}

export interface SearchResponse {
  total: number;
  jobs: JobResult[];
  sources_searched: string[];
  query: string;
}

export interface JobDetailsResponse {
  id: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  description: string | null;
  full_description: string | null;
  date_posted: string | null;
  is_remote: boolean;
  source: string;
  salary: string | null;
  department: string | null;
  application_url: string | null;
}

export interface SourceInfo {
  name: string;
  id: string;
  type: 'job_board' | 'ats' | 'company' | 'remote' | 'aggregator';
  requires_company_slug: boolean;
  description: string;
}

// ── Source Catalog ──────────────────────────────────────────────────────

const SOURCES: SourceInfo[] = [
  // Job Boards
  { name: 'LinkedIn', id: 'linkedin', type: 'job_board', requires_company_slug: false, description: 'Largest professional job board' },
  { name: 'Indeed', id: 'indeed', type: 'job_board', requires_company_slug: false, description: 'Most popular general job search engine' },
  { name: 'Glassdoor', id: 'glassdoor', type: 'job_board', requires_company_slug: false, description: 'Job board with company reviews and salary data' },
  { name: 'ZipRecruiter', id: 'zip_recruiter', type: 'job_board', requires_company_slug: false, description: 'AI-powered job matching platform' },
  { name: 'Google Jobs', id: 'google', type: 'job_board', requires_company_slug: false, description: 'Google job search aggregator' },
  { name: 'Dice', id: 'dice', type: 'job_board', requires_company_slug: false, description: 'Technology-focused job board' },
  { name: 'SimplyHired', id: 'simplyhired', type: 'job_board', requires_company_slug: false, description: 'General job search engine' },
  { name: 'Monster', id: 'monster', type: 'job_board', requires_company_slug: false, description: 'One of the original job boards' },
  { name: 'CareerBuilder', id: 'careerbuilder', type: 'job_board', requires_company_slug: false, description: 'Large general job board' },
  { name: 'StepStone', id: 'stepstone', type: 'job_board', requires_company_slug: false, description: 'European job board' },
  { name: 'Wellfound', id: 'wellfound', type: 'job_board', requires_company_slug: false, description: 'Startup and tech company jobs (formerly AngelList Talent)' },
  { name: 'Bayt', id: 'bayt', type: 'job_board', requires_company_slug: false, description: 'Middle East and North Africa job board' },
  { name: 'Naukri', id: 'naukri', type: 'job_board', requires_company_slug: false, description: 'India\'s largest job board' },
  { name: 'BDJobs', id: 'bdjobs', type: 'job_board', requires_company_slug: false, description: 'Bangladesh job board' },
  { name: 'Internshala', id: 'internshala', type: 'job_board', requires_company_slug: false, description: 'Internships and entry-level jobs (India)' },
  { name: 'Upwork', id: 'upwork', type: 'job_board', requires_company_slug: false, description: 'Freelancing and contract work platform' },
  { name: 'USAJobs', id: 'usajobs', type: 'job_board', requires_company_slug: false, description: 'US federal government jobs' },
  { name: 'Exa', id: 'exa', type: 'job_board', requires_company_slug: false, description: 'AI-powered semantic job search' },

  // Remote Job Boards
  { name: 'RemoteOK', id: 'remoteok', type: 'remote', requires_company_slug: false, description: 'Remote-first job board' },
  { name: 'Remotive', id: 'remotive', type: 'remote', requires_company_slug: false, description: 'Remote jobs in tech' },
  { name: 'We Work Remotely', id: 'weworkremotely', type: 'remote', requires_company_slug: false, description: 'Largest remote work community' },
  { name: 'Jobicy', id: 'jobicy', type: 'remote', requires_company_slug: false, description: 'Remote jobs worldwide' },
  { name: 'Himalayas', id: 'himalayas', type: 'remote', requires_company_slug: false, description: 'Remote jobs with company profiles' },
  { name: 'Arbeitnow', id: 'arbeitnow', type: 'remote', requires_company_slug: false, description: 'Remote and visa-sponsored jobs' },

  // Aggregator APIs
  { name: 'Adzuna', id: 'adzuna', type: 'aggregator', requires_company_slug: false, description: 'Job search aggregator across multiple countries' },
  { name: 'Reed', id: 'reed', type: 'aggregator', requires_company_slug: false, description: 'UK job search aggregator' },
  { name: 'Jooble', id: 'jooble', type: 'aggregator', requires_company_slug: false, description: 'International job aggregator' },
  { name: 'CareerJet', id: 'careerjet', type: 'aggregator', requires_company_slug: false, description: 'Global job search engine' },

  // ATS Platforms
  { name: 'Ashby', id: 'ashby', type: 'ats', requires_company_slug: true, description: 'Modern ATS used by growing startups' },
  { name: 'Greenhouse', id: 'greenhouse', type: 'ats', requires_company_slug: true, description: 'Popular ATS for mid-to-large companies' },
  { name: 'Lever', id: 'lever', type: 'ats', requires_company_slug: true, description: 'Collaborative ATS platform' },
  { name: 'Workable', id: 'workable', type: 'ats', requires_company_slug: true, description: 'All-in-one hiring platform' },
  { name: 'SmartRecruiters', id: 'smartrecruiters', type: 'ats', requires_company_slug: true, description: 'Enterprise talent acquisition suite' },
  { name: 'Rippling', id: 'rippling', type: 'ats', requires_company_slug: true, description: 'HR platform with ATS' },
  { name: 'Workday', id: 'workday', type: 'ats', requires_company_slug: true, description: 'Enterprise HR and ATS' },
  { name: 'BambooHR', id: 'bamboohr', type: 'ats', requires_company_slug: true, description: 'SMB-focused HR with job board' },
  { name: 'Personio', id: 'personio', type: 'ats', requires_company_slug: true, description: 'European HR platform' },
  { name: 'JazzHR', id: 'jazzhr', type: 'ats', requires_company_slug: true, description: 'SMB recruiting software' },
  { name: 'Recruitee', id: 'recruitee', type: 'ats', requires_company_slug: true, description: 'Collaborative hiring for growing companies' },
  { name: 'Teamtailor', id: 'teamtailor', type: 'ats', requires_company_slug: true, description: 'Employer branding and ATS' },
  { name: 'iCIMS', id: 'icims', type: 'ats', requires_company_slug: true, description: 'Enterprise talent cloud' },
  { name: 'Taleo', id: 'taleo', type: 'ats', requires_company_slug: true, description: 'Oracle enterprise ATS' },
  { name: 'SuccessFactors', id: 'successfactors', type: 'ats', requires_company_slug: true, description: 'SAP enterprise HR' },
  { name: 'Jobvite', id: 'jobvite', type: 'ats', requires_company_slug: true, description: 'End-to-end recruiting platform' },
  { name: 'ADP', id: 'adp', type: 'ats', requires_company_slug: true, description: 'ADP workforce solutions' },
  { name: 'UKG', id: 'ukg', type: 'ats', requires_company_slug: true, description: 'UKG HR service delivery' },
  { name: 'Breezy HR', id: 'breezyhr', type: 'ats', requires_company_slug: true, description: 'Visual hiring pipeline ATS' },
  { name: 'Comeet', id: 'comeet', type: 'ats', requires_company_slug: true, description: 'Collaborative hiring platform' },
  { name: 'Pinpoint', id: 'pinpoint', type: 'ats', requires_company_slug: true, description: 'Smart recruiting software' },

  // Company Career Pages
  { name: 'Amazon', id: 'amazon', type: 'company', requires_company_slug: false, description: 'Amazon.jobs career page' },
  { name: 'Apple', id: 'apple', type: 'company', requires_company_slug: false, description: 'Apple Jobs career page' },
  { name: 'Microsoft', id: 'microsoft', type: 'company', requires_company_slug: false, description: 'Microsoft Careers' },
  { name: 'NVIDIA', id: 'nvidia', type: 'company', requires_company_slug: false, description: 'NVIDIA Careers' },
  { name: 'TikTok', id: 'tiktok', type: 'company', requires_company_slug: false, description: 'TikTok/ByteDance careers' },
  { name: 'Uber', id: 'uber', type: 'company', requires_company_slug: false, description: 'Uber Careers' },
  { name: 'Cursor', id: 'cursor', type: 'company', requires_company_slug: false, description: 'Cursor AI careers' },
  { name: 'Google Careers', id: 'google_careers', type: 'company', requires_company_slug: false, description: 'Google career page' },
  { name: 'Meta', id: 'meta', type: 'company', requires_company_slug: false, description: 'Meta Careers' },
  { name: 'Netflix', id: 'netflix', type: 'company', requires_company_slug: false, description: 'Netflix jobs' },
  { name: 'Stripe', id: 'stripe', type: 'company', requires_company_slug: false, description: 'Stripe careers' },
  { name: 'OpenAI', id: 'openai', type: 'company', requires_company_slug: false, description: 'OpenAI careers' },

  // Phase 7: Additional Job Boards
  { name: 'BuiltIn', id: 'builtin', type: 'job_board', requires_company_slug: false, description: 'Tech-focused job board for startups and tech companies' },
  { name: 'Snagajob', id: 'snagajob', type: 'job_board', requires_company_slug: false, description: 'Hourly and part-time job board' },
  { name: 'Dribbble Jobs', id: 'dribbble', type: 'job_board', requires_company_slug: false, description: 'Design-focused job board' },

  // Phase 8: ATS Expansion
  { name: 'Manatal', id: 'manatal', type: 'ats', requires_company_slug: true, description: 'ATS for 160K+ orgs (Asia-Pacific, global SMB)' },
  { name: 'Paylocity', id: 'paylocity', type: 'ats', requires_company_slug: true, description: 'US mid-market ATS (30K+ companies)' },
  { name: 'Freshteam', id: 'freshteam', type: 'ats', requires_company_slug: true, description: 'Freshworks HR platform with ATS' },
  { name: 'Bullhorn', id: 'bullhorn', type: 'ats', requires_company_slug: true, description: '#1 ATS for staffing agencies (10K+)' },
  { name: 'Trakstar Hire', id: 'trakstar', type: 'ats', requires_company_slug: true, description: 'Formerly RecruiterBox ATS' },
  { name: 'HiringThing', id: 'hiringthing', type: 'ats', requires_company_slug: true, description: 'White-label ATS platform' },
  { name: 'Loxo', id: 'loxo', type: 'ats', requires_company_slug: true, description: 'AI-powered recruiting platform' },
  { name: 'Fountain', id: 'fountain', type: 'ats', requires_company_slug: true, description: 'High-volume hourly hiring ATS' },
  { name: 'Deel', id: 'deel', type: 'ats', requires_company_slug: true, description: 'Global hiring/EOR platform with ATS' },
  { name: 'Phenom', id: 'phenom', type: 'ats', requires_company_slug: true, description: 'Enterprise talent experience platform (900+ enterprises)' },

  // Phase 8: Company Scrapers
  { name: 'IBM', id: 'ibm', type: 'company', requires_company_slug: false, description: 'IBM Careers' },
  { name: 'Boeing', id: 'boeing', type: 'company', requires_company_slug: false, description: 'Boeing careers (Phenom-powered)' },
  { name: 'Zoom', id: 'zoom', type: 'company', requires_company_slug: false, description: 'Zoom Video careers (Eightfold)' },

  // Phase 9: Job Board Expansion
  { name: 'The Muse', id: 'themuse', type: 'job_board', requires_company_slug: false, description: 'Career advice and curated job listings' },
  { name: 'Working Nomads', id: 'workingnomads', type: 'remote', requires_company_slug: false, description: 'Curated remote jobs worldwide' },
  { name: '4 Day Week', id: 'fourdayweek', type: 'job_board', requires_company_slug: false, description: '4-day work week job listings' },
  { name: 'Startup.jobs', id: 'startupjobs', type: 'job_board', requires_company_slug: false, description: 'Startup jobs worldwide' },
  { name: 'NoDesk', id: 'nodesk', type: 'remote', requires_company_slug: false, description: 'Remote and flexible jobs' },
  { name: 'Web3 Career', id: 'web3career', type: 'job_board', requires_company_slug: false, description: 'Web3/crypto/blockchain jobs' },
  { name: 'Echojobs', id: 'echojobs', type: 'job_board', requires_company_slug: false, description: 'Curated tech jobs from top companies' },
  { name: 'Jobstreet', id: 'jobstreet', type: 'job_board', requires_company_slug: false, description: 'Major Southeast Asian job board (SEEK)' },

  // Phase 10: Government Boards & ATS Expansion
  { name: 'CareerOneStop', id: 'careeronestop', type: 'job_board', requires_company_slug: false, description: 'US Dept of Labor job search (NLx)' },
  { name: 'Arbeitsagentur', id: 'arbeitsagentur', type: 'job_board', requires_company_slug: false, description: 'German Federal Employment Agency' },
  { name: 'Jobylon', id: 'jobylon', type: 'ats', requires_company_slug: true, description: 'Scandinavian ATS (Nordic companies)' },
  { name: 'Homerun', id: 'homerun', type: 'ats', requires_company_slug: true, description: 'European SMB ATS' },
  // Phase 11: Niche boards & developer API expansion
  { name: 'Hacker News', id: 'hackernews', type: 'job_board', requires_company_slug: false, description: 'YC startup job postings via HN' },
  { name: 'Landing.jobs', id: 'landingjobs', type: 'job_board', requires_company_slug: false, description: 'European tech jobs with salary data' },
  { name: 'FindWork', id: 'findwork', type: 'aggregator', requires_company_slug: false, description: 'Developer/tech jobs aggregator' },
  { name: 'JobDataAPI', id: 'jobdataapi', type: 'aggregator', requires_company_slug: false, description: 'Global jobs aggregator API' },
  // Phase 12: ATS & niche board expansion
  { name: 'Authentic Jobs', id: 'authenticjobs', type: 'job_board', requires_company_slug: false, description: 'Creative/dev job board' },
  { name: 'JobScore', id: 'jobscore', type: 'ats', requires_company_slug: true, description: 'JobScore ATS (public JSON feed)' },
  { name: 'TalentLyft', id: 'talentlyft', type: 'ats', requires_company_slug: true, description: 'TalentLyft ATS (European)' },
  // Phase 13: RSS niche board expansion
  { name: 'CryptoJobsList', id: 'cryptojobslist', type: 'job_board', requires_company_slug: false, description: 'Crypto, blockchain & Web3 jobs' },
  { name: 'Jobspresso', id: 'jobspresso', type: 'remote', requires_company_slug: false, description: 'Curated remote jobs' },
  { name: 'HigherEdJobs', id: 'higheredjobs', type: 'job_board', requires_company_slug: false, description: 'Higher education jobs' },
  { name: 'FOSS Jobs', id: 'fossjobs', type: 'job_board', requires_company_slug: false, description: 'Free & open source software jobs' },
  { name: 'LaraJobs', id: 'larajobs', type: 'job_board', requires_company_slug: false, description: 'Laravel/PHP jobs' },
  { name: 'Python.org Jobs', id: 'pythonjobs', type: 'job_board', requires_company_slug: false, description: 'Official Python job board' },
  { name: 'Drupal Jobs', id: 'drupaljobs', type: 'job_board', requires_company_slug: false, description: 'Drupal community jobs' },
  { name: 'Real Work From Anywhere', id: 'realworkfromanywhere', type: 'remote', requires_company_slug: false, description: 'Remote jobs with category feeds' },
  { name: 'Golang Projects', id: 'golangjobs', type: 'job_board', requires_company_slug: false, description: 'Go/Golang jobs' },
  { name: 'WordPress Jobs', id: 'wordpressjobs', type: 'job_board', requires_company_slug: false, description: 'Official WordPress job board' },
  // Phase 14: API-key sources & ATS expansion
  { name: 'Talroo', id: 'talroo', type: 'aggregator', requires_company_slug: false, description: 'Major job aggregator (millions of jobs)' },
  { name: 'InfoJobs', id: 'infojobs', type: 'job_board', requires_company_slug: false, description: 'Largest job site in Spain/Southern Europe' },
  { name: 'Crelate', id: 'crelate', type: 'ats', requires_company_slug: true, description: 'Crelate ATS (recruiting firms)' },
  { name: 'iSmartRecruit', id: 'ismartrecruit', type: 'ats', requires_company_slug: true, description: 'iSmartRecruit ATS' },
  { name: 'Recruiterflow', id: 'recruiterflow', type: 'ats', requires_company_slug: true, description: 'Recruiterflow ATS' },
  // Phase 15: European government & regional boards
  { name: 'JobTech Dev', id: 'jobtechdev', type: 'job_board', requires_company_slug: false, description: 'Swedish Employment Service (50-80K jobs)' },
  { name: 'France Travail', id: 'francetravail', type: 'job_board', requires_company_slug: false, description: 'French National Employment Service (800K+ jobs)' },
  { name: 'NAV Arbeidsplassen', id: 'navjobs', type: 'job_board', requires_company_slug: false, description: 'Norwegian Labour and Welfare Administration' },
  { name: 'jobs.ac.uk', id: 'jobsacuk', type: 'job_board', requires_company_slug: false, description: 'UK academic/higher education jobs' },
  { name: 'Jobindex', id: 'jobindex', type: 'job_board', requires_company_slug: false, description: "Denmark's largest job board" },
  // Phase 16: Global expansion (LatAm, gig, startup, Canada)
  { name: 'Get on Board', id: 'getonboard', type: 'job_board', requires_company_slug: false, description: 'Latin American tech job board (6K+ jobs)' },
  { name: 'Freelancer.com', id: 'freelancercom', type: 'job_board', requires_company_slug: false, description: 'Freelance/gig marketplace (8K+ projects)' },
  { name: 'JoinRise', id: 'joinrise', type: 'job_board', requires_company_slug: false, description: 'Tech startup job aggregator (10K+ jobs)' },
  { name: 'Canada Job Bank', id: 'canadajobbank', type: 'job_board', requires_company_slug: false, description: 'Canadian government job bank (51K+ jobs)' },
  // Phase 17: Niche & international expansion (NGO, UN, IT)
  { name: 'ReliefWeb', id: 'reliefweb', type: 'job_board', requires_company_slug: false, description: 'NGO/humanitarian jobs across 195+ countries' },
  { name: 'UNDP Jobs', id: 'undpjobs', type: 'job_board', requires_company_slug: false, description: 'United Nations Development Programme jobs' },
  { name: 'DevITjobs', id: 'devitjobs', type: 'job_board', requires_company_slug: false, description: 'IT/developer jobs with salary transparency' },
  // Phase 18: Niche RSS expansion (tech, design, environment, regional)
  { name: 'PyJobs', id: 'pyjobs', type: 'job_board', requires_company_slug: false, description: 'Python developer job board' },
  { name: 'VueJobs', id: 'vuejobs', type: 'job_board', requires_company_slug: false, description: 'Vue.js/frontend developer jobs' },
  { name: 'Conservation Job Board', id: 'conservationjobs', type: 'job_board', requires_company_slug: false, description: 'Conservation/environmental sector jobs' },
  { name: 'Coroflot', id: 'coroflot', type: 'job_board', requires_company_slug: false, description: 'Design/creative industry job board' },
  { name: 'Berlin Startup Jobs', id: 'berlinstartupjobs', type: 'job_board', requires_company_slug: false, description: 'Berlin tech startup jobs' },
  // Phase 19: Tech niche, crypto, regional expansion
  { name: 'Rails Job Board', id: 'railsjobs', type: 'job_board', requires_company_slug: false, description: 'Ruby on Rails developer jobs' },
  { name: 'Elixir Jobs', id: 'elixirjobs', type: 'job_board', requires_company_slug: false, description: 'Elixir/Phoenix developer jobs' },
  { name: 'Crunchboard', id: 'crunchboard', type: 'job_board', requires_company_slug: false, description: 'TechCrunch job board' },
  { name: 'Cryptocurrency Jobs', id: 'cryptocurrencyjobs', type: 'job_board', requires_company_slug: false, description: 'Blockchain/Web3/crypto jobs' },
  { name: 'HasJob', id: 'hasjob', type: 'job_board', requires_company_slug: false, description: 'India/South Asia tech job board' },
  // Phase 20: European regional & niche expansion
  { name: 'iCrunchData', id: 'icrunchdata', type: 'job_board', requires_company_slug: false, description: 'Data science & analytics jobs' },
  { name: 'SwissDevJobs', id: 'swissdevjobs', type: 'job_board', requires_company_slug: false, description: 'Swiss IT jobs with salary transparency' },
  { name: 'GermanTechJobs', id: 'germantechjobs', type: 'job_board', requires_company_slug: false, description: 'German IT jobs with salary transparency' },
  { name: 'VirtualVocations', id: 'virtualvocations', type: 'remote', requires_company_slug: false, description: 'Screened remote/work-from-home jobs' },
  { name: 'NoFluffJobs', id: 'nofluffjobs', type: 'job_board', requires_company_slug: false, description: 'Polish/CEE tech jobs with salary transparency' },
  // Phase 21: Niche & academic expansion
  { name: 'Green Jobs Board', id: 'greenjobsboard', type: 'job_board', requires_company_slug: false, description: 'Environmental & sustainability jobs' },
  { name: 'EuroJobs', id: 'eurojobs', type: 'job_board', requires_company_slug: false, description: 'European multi-country job board' },
  { name: 'Open Source Design Jobs', id: 'opensourcedesignjobs', type: 'job_board', requires_company_slug: false, description: 'Design jobs for open source projects' },
  { name: 'Academic Careers', id: 'academiccareers', type: 'job_board', requires_company_slug: false, description: 'Higher education & academic positions' },
  { name: 'RemoteFirstJobs', id: 'remotefirstjobs', type: 'remote', requires_company_slug: false, description: 'Remote-first job listings' },
  // Phase 22: Eastern European, CIS & Singapore expansion
  { name: 'Djinni', id: 'djinni', type: 'job_board', requires_company_slug: false, description: 'Ukrainian tech job board' },
  { name: 'HeadHunter', id: 'headhunter', type: 'job_board', requires_company_slug: false, description: 'Russian/CIS job board (140K+ vacancies)' },
  { name: 'Habr Career', id: 'habrcareer', type: 'job_board', requires_company_slug: false, description: 'Russian tech job board (Habr community)' },
  { name: 'MyCareersFuture', id: 'mycareersfuture', type: 'job_board', requires_company_slug: false, description: 'Singapore government job portal (77K+ jobs)' },
  // Phase 23: Japan, Nordic & Swiss expansion
  { name: 'Jobs in Japan', id: 'jobsinjapan', type: 'job_board', requires_company_slug: false, description: 'English-language Japan tech jobs' },
  { name: 'Duunitori', id: 'duunitori', type: 'job_board', requires_company_slug: false, description: 'Finnish job board' },
  { name: 'Jobs.ch', id: 'jobsch', type: 'job_board', requires_company_slug: false, description: 'Swiss job board' },
  // Phase 24: UK & mobile dev expansion
  { name: 'Guardian Jobs', id: 'guardianjobs', type: 'job_board', requires_company_slug: false, description: 'UK job board (The Guardian newspaper)' },
  { name: 'AndroidJobs', id: 'androidjobs', type: 'job_board', requires_company_slug: false, description: 'Android developer job board' },
  { name: 'iOS Dev Jobs', id: 'iosdevjobs', type: 'job_board', requires_company_slug: false, description: 'iOS/Swift developer job board' },
  // Phase 25: DevOps, FP, diversity & niche expansion
  { name: 'DevOpsJobs', id: 'devopsjobs', type: 'job_board', requires_company_slug: false, description: 'DevOps & infrastructure job board (875+ jobs)' },
  { name: 'Functional Works', id: 'functionalworks', type: 'job_board', requires_company_slug: false, description: 'Functional programming job board (Haskell, Scala, Clojure, Erlang)' },
  { name: 'PowerToFly', id: 'powertofly', type: 'job_board', requires_company_slug: false, description: 'Diversity-focused remote job board' },
  { name: 'Clojure Jobs', id: 'clojurejobs', type: 'job_board', requires_company_slug: false, description: 'Clojure programming language job board' },
  // Phase 26: Sustainability & niche expansion
  { name: 'EcoJobs', id: 'ecojobs', type: 'job_board', requires_company_slug: false, description: 'Environmental and conservation job board' },
];

// ── Tool Implementations ───────────────────────────────────────────────

/**
 * Search for jobs via the Ever Jobs API.
 */
export async function searchJobs(params: JobSearchParams): Promise<SearchResponse> {
  const client = getClient();

  try {
    const response = await client.post('/api/jobs/search', buildSearchRequestBody(params));

    const data = response.data;
    const locationFormat = readLocationFormat();
    const jobs: JobResult[] = (data.jobs ?? []).map((job: any) => ({
      id: job.id ?? '',
      title: job.title ?? '',
      company: job.companyName ?? job.company_name ?? '',
      location: formatJobLocation(job.location, locationFormat),
      url: job.jobUrl ?? job.job_url ?? '',
      description: truncateDescription(job.description),
      date_posted: job.datePosted ?? job.date_posted ?? null,
      is_remote: job.isRemote ?? job.is_remote ?? false,
      source: job.site ?? '',
      salary: formatSalary(job.compensation),
      department: job.department ?? null,
    }));

    // Filter remote-only if requested
    const filteredJobs = params.remoteOnly
      ? jobs.filter((j) => j.is_remote)
      : jobs;

    return {
      total: filteredJobs.length,
      jobs: filteredJobs,
      sources_searched: params.source ? [params.source] : ['all'],
      query: params.query,
    };
  } catch (err: any) {
    // If the API is unavailable, return a helpful error
    if (err.code === 'ECONNREFUSED') {
      return {
        total: 0,
        jobs: [],
        sources_searched: [],
        query: params.query,
      };
    }
    throw new Error(`Search failed: ${err.message}`);
  }
}

/**
 * Get detailed information about a specific job.
 */
export async function getJobDetails(params: {
  jobUrl?: string;
  jobId?: string;
}): Promise<JobDetailsResponse> {
  if (!params.jobUrl && !params.jobId) {
    throw new Error('Either job_url or job_id must be provided');
  }

  const client = getClient();

  try {
    const response = await client.get('/api/jobs/details', {
      params: {
        url: params.jobUrl,
        id: params.jobId,
      },
    });

    const job = response.data;
    return {
      id: job.id ?? '',
      title: job.title ?? '',
      company: job.companyName ?? job.company_name ?? '',
      location: formatJobLocation(job.location, readLocationFormat()),
      url: job.jobUrl ?? job.job_url ?? '',
      description: truncateDescription(job.description),
      full_description: job.description ?? null,
      date_posted: job.datePosted ?? job.date_posted ?? null,
      is_remote: job.isRemote ?? job.is_remote ?? false,
      source: job.site ?? '',
      salary: formatSalary(job.compensation),
      department: job.department ?? null,
      application_url: job.applicationUrl ?? job.application_url ?? job.jobUrl ?? null,
    };
  } catch (err: any) {
    throw new Error(`Failed to get job details: ${err.message}`);
  }
}

/**
 * List available job sources, optionally filtered by type.
 */
export function listSources(
  type: string = 'all',
): { total: number; sources: SourceInfo[] } {
  const filtered =
    type === 'all'
      ? SOURCES
      : SOURCES.filter((s) => s.type === type);

  return {
    total: filtered.length,
    sources: filtered,
  };
}

/**
 * Convenience: search remote jobs across all remote-first boards.
 */
export async function searchRemoteJobs(params: {
  query: string;
  source?: string;
  limit?: number;
}): Promise<SearchResponse> {
  const remoteSources = SOURCES.filter((s) => s.type === 'remote').map((s) => s.id);
  const targetSource = params.source && remoteSources.includes(params.source)
    ? params.source
    : undefined;

  return searchJobs({
    query: params.query,
    location: 'Remote',
    source: targetSource,
    limit: params.limit ?? 25,
    remoteOnly: true,
  });
}

/**
 * Get salary insights: aggregate salary data from search results.
 */
export async function getSalaryInsights(params: {
  query: string;
  location?: string;
  limit?: number;
}): Promise<SalaryInsightsResponse> {
  const searchResult = await searchJobs({
    query: params.query,
    location: params.location,
    limit: params.limit ?? 50,
  });

  const jobsWithSalary = searchResult.jobs.filter((j) => j.salary);
  const salaryValues: number[] = [];

  for (const job of jobsWithSalary) {
    const nums = job.salary!.match(/[\d,]+/g);
    if (nums) {
      for (const n of nums) {
        const val = parseInt(n.replace(/,/g, ''), 10);
        if (val > 1000 && val < 1000000) salaryValues.push(val);
      }
    }
  }

  salaryValues.sort((a, b) => a - b);

  const median = salaryValues.length > 0
    ? salaryValues[Math.floor(salaryValues.length / 2)]
    : null;

  return {
    query: params.query,
    location: params.location ?? 'Any',
    totalJobsSearched: searchResult.total,
    jobsWithSalary: jobsWithSalary.length,
    salaryPercentage: searchResult.total > 0
      ? Math.round((jobsWithSalary.length / searchResult.total) * 100)
      : 0,
    stats: salaryValues.length > 0
      ? {
          min: Math.min(...salaryValues),
          max: Math.max(...salaryValues),
          median: median!,
          p25: salaryValues[Math.floor(salaryValues.length * 0.25)] ?? median!,
          p75: salaryValues[Math.floor(salaryValues.length * 0.75)] ?? median!,
        }
      : null,
    sampleJobs: jobsWithSalary.slice(0, 10).map((j) => ({
      title: j.title,
      company: j.company,
      salary: j.salary!,
      source: j.source,
      location: j.location,
    })),
  };
}

export interface SalaryInsightsResponse {
  query: string;
  location: string;
  totalJobsSearched: number;
  jobsWithSalary: number;
  salaryPercentage: number;
  stats: {
    min: number;
    max: number;
    median: number;
    p25: number;
    p75: number;
  } | null;
  sampleJobs: {
    title: string;
    company: string;
    salary: string;
    source: string;
    location: string | null;
  }[];
}

/**
 * Compare job sources by result quality metrics.
 */
export function compareSources(): {
  total: number;
  byType: Record<string, number>;
  types: {
    type: string;
    count: number;
    sources: string[];
    requiresSlug: boolean;
  }[];
} {
  const byType: Record<string, SourceInfo[]> = {};
  for (const source of SOURCES) {
    if (!byType[source.type]) byType[source.type] = [];
    byType[source.type].push(source);
  }

  const typeCounts: Record<string, number> = {};
  const types = Object.entries(byType).map(([type, sources]) => {
    typeCounts[type] = sources.length;
    return {
      type,
      count: sources.length,
      sources: sources.map((s) => s.name),
      requiresSlug: sources.some((s) => s.requires_company_slug),
    };
  });

  return {
    total: SOURCES.length,
    byType: typeCounts,
    types,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build the `POST /api/jobs/search` body for {@link searchJobs}. See
 * {@link SearchRequestKeyStyle} for why camelCase is the default (Specs 1689,
 * 1690 §4.9).
 *
 * An absent source or company is omitted, not sent as an `undefined` key, so an
 * unfiltered search stays exactly `{ searchTerm, location, resultsWanted }`. The
 * per-request `crawl` object (Spec 1690) is added unchanged when given — its key
 * is spelled the same in every style, and its own keys are the camelCase ones
 * the API's `CrawlPolicyDto` declares.
 */
export function buildSearchRequestBody(
  params: JobSearchParams,
  style: SearchRequestKeyStyle = readSearchRequestKeyStyle(),
): Record<string, unknown> {
  const siteType = params.source ? [params.source] : undefined;
  const resultsWanted = Math.min(params.limit ?? 20, 100);
  const location = params.location ?? '';

  const camel = {
    searchTerm: params.query,
    location,
    ...(siteType ? { siteType } : {}),
    ...(params.company ? { companySlug: params.company } : {}),
    resultsWanted,
  };
  const snake = {
    search_term: params.query,
    location,
    ...(siteType ? { site_type: siteType } : {}),
    ...(params.company ? { company_slug: params.company } : {}),
    results_wanted: resultsWanted,
  };
  const crawl = params.crawl ? { crawl: params.crawl } : {};

  if (style === 'snake') return { ...snake, ...crawl };
  if (style === 'both') return { ...snake, ...camel, ...crawl };
  return { ...camel, ...crawl };
}

/**
 * Render the API's structured location as the `string | null` the MCP tools
 * declare. The API returns a `LocationDto` object (`city`/`state`/`country`,
 * plus the source's `name` and raw `text`); older servers may return a plain
 * string, which is passed through.
 *
 * Remote-only postings carry no location object at all and render `null` —
 * `is_remote` carries that signal.
 */
export function formatJobLocation(
  location: unknown,
  format: LocationFormat = 'full',
): string | null {
  if (location == null) return null;
  if (typeof location === 'string') return nonEmpty(location);
  if (typeof location !== 'object') return null;

  const loc = location as Record<string, unknown>;
  const city = nonEmpty(loc.city);
  if (format === 'city' && city) return city;

  const geo = [city, nonEmpty(loc.state), nonEmpty(loc.country)].filter(
    (part): part is string => part !== null,
  );
  if (geo.length > 0) return geo.join(', ');

  return nonEmpty(loc.name) ?? nonEmpty(loc.text);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const maxLen = 500;
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen) + '...';
}

function formatSalary(compensation: any): string | null {
  if (!compensation) return null;
  const { minAmount, maxAmount, currency } = compensation;
  if (!minAmount && !maxAmount) return null;
  const cur = currency ?? 'USD';
  if (minAmount && maxAmount) return `${cur} ${minAmount.toLocaleString()} - ${maxAmount.toLocaleString()}`;
  if (minAmount) return `${cur} ${minAmount.toLocaleString()}+`;
  return `Up to ${cur} ${maxAmount.toLocaleString()}`;
}
