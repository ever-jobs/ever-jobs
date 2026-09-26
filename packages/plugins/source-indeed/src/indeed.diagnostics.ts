import { classifyScrapeError, looksLikeChallenge, ScrapeDiagnostics } from '@ever-jobs/models';

/**
 * Turn a failed or empty `jobSearch` call into a diagnostic (Spec 1702).
 *
 * The endpoint answers in three shapes a scrape can trip over: an edge block
 * page (HTML, usually HTTP 403), a GraphQL error envelope (`{ errors: [...] }`,
 * HTTP 400 for a document the schema rejects, or HTTP 200), and a 200 with no
 * `data.jobSearch`. Each used to end the scrape as a silent empty result.
 */

const MAX_DETAIL = 300;

/** GraphQL error codes that mean the request itself was wrong. */
const BAD_INPUT_CODES: ReadonlySet<string> = new Set([
  'GRAPHQL_VALIDATION_FAILED',
  'GRAPHQL_PARSE_FAILED',
  'BAD_USER_INPUT',
  'BAD_REQUEST',
]);

/** GraphQL error codes that mean the server refused us. */
const BLOCKED_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'CSRF_ERROR']);

/** Block-page markers `looksLikeChallenge` does not cover (a hard block is not a challenge). */
const BLOCK_PAGE_RE = /you have been blocked|cf-error-details|cloudflare ray id/i;

interface GraphqlError {
  message?: unknown;
  extensions?: { code?: unknown } | null;
}

function truncate(value: string): string {
  return value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL - 3)}...` : value;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** A JSON object body, or a string body that is one. Anything else is `null`. */
function jsonObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (typeof body === 'string' && body.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function graphqlErrors(body: unknown): GraphqlError[] {
  const errors = jsonObject(body)?.errors;
  return Array.isArray(errors)
    ? errors.filter((e): e is GraphqlError => !!e && typeof e === 'object')
    : [];
}

/** The first GraphQL error's `extensions.code`, if any. */
export function graphqlErrorCode(body: unknown): string | null {
  const code = graphqlErrors(body)[0]?.extensions?.code;
  return typeof code === 'string' && code.trim() !== '' ? code.trim() : null;
}

/**
 * The first GraphQL error as `message [CODE]`, noting how many more there
 * were, truncated to 300 characters. `null` when the body carries no errors.
 */
export function graphqlErrorDetail(body: unknown): string | null {
  const errors = graphqlErrors(body);
  if (errors.length === 0) return null;
  const message = typeof errors[0].message === 'string' ? collapse(errors[0].message) : '';
  const code = graphqlErrorCode(body);
  const parts = [message || 'GraphQL error without a message'];
  if (code) parts.push(`[${code}]`);
  if (errors.length > 1) parts.push(`(+${errors.length - 1} more)`);
  return truncate(parts.join(' '));
}

/** Does the body look like an edge block or challenge page rather than an API answer? */
export function isBlockPage(body: unknown): boolean {
  if (typeof body !== 'string' || body === '') return false;
  return looksLikeChallenge(body) || BLOCK_PAGE_RE.test(body);
}

/**
 * Diagnose GraphQL errors in a body. Validation and parse errors are
 * `bad_input`, authentication and CSRF refusals are `blocked`, anything else
 * is `unknown`. `null` when the body carries no errors.
 */
export function diagnoseGraphqlErrors(body: unknown): ScrapeDiagnostics | null {
  const detail = graphqlErrorDetail(body);
  if (!detail) return null;
  const code = graphqlErrorCode(body);
  const message = `GraphQL: ${detail}`;
  if (code && BAD_INPUT_CODES.has(code)) return new ScrapeDiagnostics('bad_input', message);
  if (code && BLOCKED_CODES.has(code)) return new ScrapeDiagnostics('blocked', message);
  return new ScrapeDiagnostics('unknown', message);
}

/** Why a successful HTTP response carried no `data.jobSearch`. Never `null`. */
export function diagnoseMissingJobSearch(body: unknown): ScrapeDiagnostics {
  if (isBlockPage(body)) {
    return new ScrapeDiagnostics('blocked', 'HTTP 200 with an edge block page (cloudflare) instead of JSON');
  }
  const errors = diagnoseGraphqlErrors(body);
  if (errors) return errors;
  if (typeof body === 'string') {
    return new ScrapeDiagnostics('unknown', `non-JSON response (${body.length} characters), no data.jobSearch`);
  }
  return new ScrapeDiagnostics('unknown', 'response had no data.jobSearch');
}

/**
 * Diagnose a request that threw (an HTTP error status, a timeout, a network
 * failure). The generic HTTP client message is enriched with the GraphQL
 * error text and a block-page marker from the response body before it is
 * classified, so a 400 names the offending field and an edge block reads as
 * `blocked` even when its status alone would not say so. A GraphQL error code
 * the server sent (validation, CSRF, authentication) decides the reason ahead
 * of the status line.
 */
export function diagnoseHttpError(err: unknown): ScrapeDiagnostics {
  const e = (err && typeof err === 'object' ? err : {}) as {
    message?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: unknown } | null;
  };
  const message =
    typeof e.message === 'string' && e.message.trim() !== '' ? e.message.trim() : String(err ?? 'unknown error');
  const status = typeof e.response?.status === 'number' ? e.response.status : null;
  const body = e.response?.data;

  const parts = [message];
  if (status !== null && !message.includes(String(status))) parts.push(`(HTTP ${status})`);
  const gql = graphqlErrorDetail(body);
  if (gql) parts.push(`- GraphQL: ${gql}`);
  if (isBlockPage(body)) parts.push('- edge block page (cloudflare)');

  const detail = parts.join(' ');

  // The server's own error code is more precise than the status line.
  const code = graphqlErrorCode(body);
  if (code && BLOCKED_CODES.has(code)) return new ScrapeDiagnostics('blocked', truncate(detail));
  if (code && BAD_INPUT_CODES.has(code)) return new ScrapeDiagnostics('bad_input', truncate(detail));

  const enriched = Object.assign(new Error(detail), {
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
  });
  return classifyScrapeError(enriched);
}
