/**
 * ReliefWeb API v2 jobs endpoint (Spec 1752). v1 is decommissioned: on
 * 2026-09-25 `GET /v1/jobs` answered HTTP 410
 * `{"error":{"message":"The API version 'v1' has been decommissioned. Please use version 'v2' instead."}}`.
 * v2 takes the same GET parameters (`appname`, `limit`, `offset`,
 * `fields[include][]`, `query[value]`) — https://apidoc.reliefweb.int/.
 */
export const RELIEFWEB_API_URL = 'https://api.reliefweb.int/v2/jobs';

/**
 * Environment variable holding the ReliefWeb `appname`. Since 1 November 2025
 * ReliefWeb only serves PRE-APPROVED appnames (request one at
 * https://apidoc.reliefweb.int/parameters#appname — "a combination of your
 * (organization) name, purpose and random characters"). Any other appname gets
 * HTTP 403 `AccessDeniedHttpException` "You are not using an approved appname"
 * (verified live 2026-09-25 with the default below).
 */
export const RELIEFWEB_APP_NAME_ENV = 'RELIEFWEB_APPNAME';

/** Neutral default appname, used when `RELIEFWEB_APPNAME` is unset (not approved by ReliefWeb as of 2026-09-25). */
export const RELIEFWEB_APP_NAME = 'ever-jobs';

/** Where an operator requests an approved appname; quoted in the 403 diagnostic. */
export const RELIEFWEB_APP_NAME_DOCS_URL = 'https://apidoc.reliefweb.int/parameters#appname';

export const RELIEFWEB_DEFAULT_RESULTS = 25;
export const RELIEFWEB_MAX_RESULTS = 100;

export const RELIEFWEB_HEADERS: Record<string, string> = {
  'Accept': 'application/json',
  'User-Agent': 'ever-jobs/0.1.0 (job-aggregator)',
};

/**
 * Job fields requested from v2 (https://apidoc.reliefweb.int/fields-tables):
 * `url` is the "Canonical url", `url_alias` the "'Friendly' url of the job"
 * (`https://reliefweb.int/job/<id>/<slug>`, the page's own `rel=canonical`);
 * `body` is Markdown and `body-html` its HTML rendering.
 */
export const RELIEFWEB_FIELDS = [
  'title', 'body', 'body-html', 'url', 'url_alias', 'source', 'date', 'country', 'theme', 'type',
];

/**
 * Public page of a ReliefWeb job by node id (Spec 1751) — the last resort when
 * the API returns neither `url_alias` nor `url`. Each entry's `href` is its API
 * resource (`https://api.reliefweb.int/v2/jobs/<id>`) and must never become a
 * link. Verified 2026-09-25: `/node/4231248` → 301 to
 * `/job/4231248/full-stack-software-developer`; `/node/4228316` (a closed job)
 * → 410 HTML whose `rel=canonical` is `/job/4228316/operations-officer`.
 */
export const RELIEFWEB_PUBLIC_NODE_URL = 'https://reliefweb.int/node';
