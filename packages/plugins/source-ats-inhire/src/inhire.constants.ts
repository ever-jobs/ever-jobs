import type { PluginCrawlPolicy } from '@ever-jobs/common';
import { JobType, Site } from '@ever-jobs/models';

/**
 * Constants for the InHire careers platform (Spec 1692).
 *
 * InHire (inhire.app, Brazil) is an applicant-tracking system. Every customer
 * company (a "tenant") gets its own hosted career page, and those pages load
 * their openings from a public, unauthenticated JSON API on one shared origin.
 * The tenant is named by an `X-Tenant` request header, not by the URL:
 *
 *   GET https://api.inhire.app/job-posts/public/pages/lean        (every open role)
 *   GET https://api.inhire.app/job-posts/public/pages/{jobId}     (one role, full record)
 *
 * The lean list is one JSON array, not paginated. Each row carries a UUID
 * `jobId`, a `displayName` (title), the career page it belongs to, and a
 * `link` to the candidate-facing page on `https://{tenant}.inhire.com.br/vagas/{jobId}`.
 * Dates, location, contract type and the description only come from the
 * detail record, so a scrape is one list call plus a bounded number of detail
 * calls.
 *
 * Verified live 2026-09-24 (3 requests, honest User-Agent, no challenge, no
 * cookie): tenant `olist` listed 19 roles; one detail returned
 * `status: "published"`, `workplaceType: "Remote"`, `location: "BR"`.
 *
 * robots.txt: `https://api.inhire.app/robots.txt` answers the gateway's JSON
 * `403 {"message":"Forbidden"}` for an unknown route, so the API host publishes
 * no robots file and nothing is disallowed. Defence in depth: the service only
 * ever builds URLs under {@link INHIRE_PUBLIC_PATH_PREFIX} and refuses any
 * other path. The tenant hosts (`{tenant}.inhire.com.br`) are never fetched;
 * the plugin only emits links to them.
 *
 * Input semantics:
 * - `searchTerm` is matched against the **title in the lean list only**,
 *   before any detail call, so a search costs no extra request. The match
 *   ignores case and accents (`senior` matches `Sênior`) and needs every
 *   whitespace-separated word of the term in the title.
 * - `location`, `isRemote` (only when `true`), `jobType` and `hoursOld` need
 *   the detail record, so they are applied after it; details are fetched in
 *   list order until enough roles match or the detail budget is spent.
 * - `country` is ignored: the input DTO defaults it to USA, and tenants are
 *   Brazilian in practice.
 */

/** Site value for this plugin (`Site.INHIRE = 'inhire'`). */
export const INHIRE_SITE: Site = Site.INHIRE;

/** `atsType` stamped on every job. */
export const INHIRE_ATS_TYPE = 'inhire';

/** The one host the plugin sends requests to. */
export const INHIRE_API_HOST = 'api.inhire.app';

/** Origin of every request. A caller-supplied URL is never fetched. */
export const INHIRE_API_ORIGIN = `https://${INHIRE_API_HOST}`;

/** Every request path starts with this prefix (robots defence in depth). */
export const INHIRE_PUBLIC_PATH_PREFIX = '/job-posts/public/pages/';

/** Lean list of every published role of the tenant. */
export const INHIRE_LIST_PATH = `${INHIRE_PUBLIC_PATH_PREFIX}lean`;

/** Detail path for one role; the id must already be a validated UUID. */
export const inhireDetailPath = (jobId: string): string =>
  `${INHIRE_PUBLIC_PATH_PREFIX}${encodeURIComponent(jobId)}`;

/** Request header that selects the tenant. */
export const INHIRE_TENANT_HEADER = 'X-Tenant';

/**
 * Candidate-facing tenant hosts. `{tenant}.inhire.com.br` is where the list's
 * `link` points; `{tenant}.inhire.app` is accepted as input and as a link host.
 */
export const INHIRE_TENANT_HOST_SUFFIXES: readonly string[] = ['.inhire.com.br', '.inhire.app'];

/** Host suffix used to build the canonical public job URL. */
export const INHIRE_CANONICAL_HOST_SUFFIX = '.inhire.com.br';

/** Path segment of the public job page: `https://{tenant}.inhire.com.br/vagas/{jobId}`. */
export const INHIRE_JOB_PATH = 'vagas';

/**
 * Leading labels that are InHire infrastructure, never a tenant. `portal` is
 * deliberately absent: it is reported as a real tenant.
 */
export const INHIRE_RESERVED_LABELS: ReadonlySet<string> = new Set(['api', 'files', 'www']);

/** One DNS label: lower-case letters, digits and inner hyphens, 1–63 chars. */
export const INHIRE_TENANT_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A role id: a UUID (any version). Validated before it is used in a path. */
export const INHIRE_JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Honest, identifiable User-Agent. The live probe was accepted with it; no
 * browser User-Agent and no client-identification header is sent.
 */
export const INHIRE_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

/** Default headers for every request (the tenant header is added per request). */
export const INHIRE_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': INHIRE_USER_AGENT,
};

/** `resultsWanted` when the caller leaves it unset, like the sibling ATS adapters. */
export const INHIRE_DEFAULT_RESULTS = 100;

/**
 * Upper bound (seconds) on the per-request timeout. The API answered in 1.9 to
 * 3.7 s cold; a caller may ask for a shorter timeout, never a longer one.
 */
export const INHIRE_DEFAULT_TIMEOUT_SECONDS = 15;

/** Hard cap on list rows considered per scrape; the rest are logged and dropped. */
export const INHIRE_MAX_LIST_ITEMS = 500;

/** Detail calls when `descriptionDepth` is unset. */
export const INHIRE_DEFAULT_DETAIL_BUDGET = 50;

/** Detail calls for `descriptionDepth: 'detail-25'`. */
export const INHIRE_DETAIL_25_BUDGET = 25;

/** Hard ceiling on detail calls per scrape, including `descriptionDepth: 'detail-all'`. */
export const INHIRE_MAX_DETAIL_FETCHES = 200;

/**
 * Consecutive failed detail calls after which the walk stops and returns what
 * it has. A refusal (429, 401/403/407, a block or challenge) stops it at once.
 */
export const INHIRE_DETAIL_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Detail requests in flight at once. The crawl policy this plugin ships with
 * fetches detail records one after another, so the default is 1 (sequential).
 * `INHIRE_DETAIL_CONCURRENCY=2` allows a two-worker pool; nothing higher is
 * accepted.
 */
export const INHIRE_DETAIL_CONCURRENCY = 1;

/** Largest value `INHIRE_DETAIL_CONCURRENCY` may take. */
export const INHIRE_MAX_DETAIL_CONCURRENCY = 2;

/** Env var that overrides {@link INHIRE_DETAIL_CONCURRENCY} (integer 1–2). */
export const INHIRE_DETAIL_CONCURRENCY_ENV = 'INHIRE_DETAIL_CONCURRENCY';

/**
 * Minimum gap between request starts to the API host, across every worker and
 * every concurrent scrape in the process (all tenants share one origin). A
 * caller's `rateDelayMin` still applies on top, inside the HTTP client.
 */
export const INHIRE_MIN_INTERVAL_MS = 500;

/** Largest value `INHIRE_MIN_INTERVAL_MS` may be raised to. */
export const INHIRE_MAX_MIN_INTERVAL_MS = 60_000;

/**
 * Env var that raises {@link INHIRE_MIN_INTERVAL_MS} (integer milliseconds).
 * A value below the default is raised to the default: the gap can only grow.
 */
export const INHIRE_MIN_INTERVAL_ENV = 'INHIRE_MIN_INTERVAL_MS';

/**
 * The plugin's crawl-policy defaults (`@SourcePlugin({ crawl })`, Spec 1690),
 * declaring the pacing this plugin was designed with (Spec 1692 §10): every
 * tenant shares the one API host, requests start at least
 * {@link INHIRE_MIN_INTERVAL_MS} apart, and never more than
 * {@link INHIRE_MAX_DETAIL_CONCURRENCY} are in flight (1 by default; the
 * plugin's own pool decides). The module-level slot reservation keeps pacing
 * outside a scrape context too. Operators (`EVER_JOBS_CRAWL_POLICIES`
 * `sites.inhire`) and search callers (`crawl`) can override it; the identity
 * stays with the global policy (no `userAgentMode` opt-in).
 */
export const INHIRE_CRAWL_POLICY: PluginCrawlPolicy = {
  maxConcurrentPerHost: INHIRE_MAX_DETAIL_CONCURRENCY,
  minIntervalMs: INHIRE_MIN_INTERVAL_MS,
};

/** A role is emitted only with this status; anything else is skipped and counted. */
export const INHIRE_PUBLISHED_STATUS = 'published';

/** Longest `message` from an error body copied into a diagnostic. */
export const INHIRE_MAX_MESSAGE_LENGTH = 200;

/** `workplaceType` tokens (compared lower-cased and accent-free). */
export const INHIRE_REMOTE_WORKPLACE_TYPES: ReadonlySet<string> = new Set(['remote', 'remoto']);
export const INHIRE_HYBRID_WORKPLACE_TYPES: ReadonlySet<string> = new Set(['hybrid', 'hibrido']);

/**
 * Location parts that describe the workplace, not a place. They are dropped
 * before the label reaches the location parser (compared accent-free).
 */
export const INHIRE_WORKPLACE_WORDS: ReadonlySet<string> = new Set([
  'remoto',
  'remote',
  'hibrido',
  'hybrid',
  'presencial',
  'on-site',
  'onsite',
]);

/** Country appended to a Brazilian location label that names none. */
export const INHIRE_DEFAULT_COUNTRY = 'Brazil';
export const INHIRE_DEFAULT_COUNTRY_CODE = 'BR';

/**
 * The 27 Brazilian federative-unit codes. Several are also ISO country codes
 * (`RS` Serbia, `PR` Puerto Rico, `SC` Seychelles, `ES` Spain …), so a label
 * ending in one of them is read as a Brazilian state and the country is added.
 */
export const INHIRE_BRAZIL_STATE_CODES: ReadonlySet<string> = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);

/**
 * Brazilian contract labels (`contractType[]`) mapped to job types. Keys are
 * lower-case and accent-free. A token not listed here falls back to the shared
 * `getJobTypeFromString`; an unknown token is ignored. Only `CLT` was seen live.
 *
 * `Aprendiz` / `Jovem Aprendiz` (the Brazilian apprenticeship programme) map
 * to APPRENTICESHIP, the type the shared vocabulary now has for paid training
 * contracts.
 */
export const INHIRE_CONTRACT_TYPE_MAP: ReadonlyMap<string, JobType> = new Map([
  ['clt', JobType.FULL_TIME],
  ['efetivo', JobType.FULL_TIME],
  ['trainee', JobType.FULL_TIME],
  ['pj', JobType.CONTRACT],
  ['freelancer', JobType.CONTRACT],
  ['autonomo', JobType.CONTRACT],
  ['cooperado', JobType.CONTRACT],
  ['estagio', JobType.INTERNSHIP],
  ['aprendiz', JobType.APPRENTICESHIP],
  ['jovem aprendiz', JobType.APPRENTICESHIP],
  ['temporario', JobType.TEMPORARY],
]);

/** A title naming an internship (matched on the lower-case, accent-free title). */
export const INHIRE_INTERNSHIP_TITLE_RE = /\b(estagio|estagiari[oa]|intern(ship)?)\b/;

/**
 * Brazilian-currency marker. The shared salary parser reads the `$` inside
 * `R$` as US dollars, so a description carrying one is not salary-parsed.
 */
export const INHIRE_BRL_MARKER_RE = /R\$|\bBRL\b/i;
