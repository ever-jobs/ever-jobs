/**
 * Public-URL guard for the links a plugin hands to people (Spec 1751).
 *
 * `JobPostDto.jobUrl`, `jobUrlDirect` and `applyUrl` are what a downstream
 * app renders as the "View" / "Apply" link — the documented precedence is
 * `applyUrl ?? jobUrl ?? jobUrlDirect`. Every one of them must therefore be a
 * page a person can open, never the JSON/REST resource the plugin read the
 * posting from. SmartRecruiters' posting `ref`
 * (`https://api.smartrecruiters.com/v1/companies/<Co>/postings/<id>`) went
 * into `jobUrl` for every posting until Spec 1750, so thousands of stored
 * rows sent users to raw JSON.
 *
 * This module is the single definition of "looks like an API URL". It is used
 * at runtime (to refuse an API-shaped candidate before it becomes a link) and
 * by the static guard `scripts/__tests__/plugin-job-url-hosts.spec.ts` (which
 * fails the build when a plugin wires an API host into one of those fields).
 *
 * 🛑 It is a shape heuristic, not a fetch: it cannot prove a URL serves HTML.
 * It errs toward flagging (`/api/`, `/v1/`, `.json`, an `api.` host label), so
 * a rare human page with such a path is refused and the caller's next
 * candidate wins.
 */

/**
 * Markers of a machine endpoint in a URL or URL fragment:
 *
 * - an `api.` / `*-api.` / `graphql.` host label (`api.smartrecruiters.com`,
 *   `boards-api.greenhouse.io`, `graphql.acme.roubler.com`);
 * - an `/api/`, `/v1/`, `/graphql`, `/rest-services/`, `/hcmRestApi/` or
 *   Workday `/wday/cxs/` path segment;
 * - a `.json` resource.
 */
export const API_URL_PATTERN =
  /(?:^|\/\/|\.)(?:api|[a-z0-9-]+-api|graphql)\.|\/api(?:\/|$|\?)|\/v1(?:\/|$|\?)|\/graphql(?:\/|$|\?)|\/rest-services\/|\/hcmRestApi\/|\/wday\/cxs\/|\.json(?:$|[?#/])/i;

/** Longest URL the helpers will consider; longer input is treated as unusable. */
const PUBLIC_URL_MAX_LENGTH = 4096;

/**
 * True when `url` has the shape of an API/JSON endpoint rather than a page a
 * person can open. Non-strings and empty strings are not API URLs (they are
 * simply unusable — see {@link firstPublicUrl}).
 */
export function isApiLikeUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return API_URL_PATTERN.test(trimmed.slice(0, PUBLIC_URL_MAX_LENGTH));
}

/**
 * The first candidate that is an absolute `http(s)` URL and does not look like
 * an API endpoint, trimmed; `null` when none qualifies.
 *
 * Use it wherever a posting's link is chosen from several source fields, so an
 * API reference can never be the one that wins:
 *
 * ```ts
 * const jobUrl = firstPublicUrl(job.postingUrl, job.url) ?? publicPattern;
 * ```
 */
export function firstPublicUrl(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > PUBLIC_URL_MAX_LENGTH) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    if (!parsed.hostname) continue;
    if (isApiLikeUrl(trimmed)) continue;
    return trimmed;
  }
  return null;
}
