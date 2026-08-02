import { Site } from '@ever-jobs/models';

/**
 * Hardcoded upstream exceptions for domains whose plugin token does not follow
 * the Spec 5069 rule. These plugins predate the domain-token convention and are
 * kept as-is to avoid merge conflicts with upstream.
 */
const DOMAIN_TO_TOKEN_EXCEPTIONS: Readonly<Record<string, string>> = {
  'divergent.us': 'divergent',
  'nuro.ai': 'nuro',
};

/**
 * Extract the hostname from a raw string that may be a full URL, a protocol-
 * relative URL, or a bare domain.
 */
function extractHost(domainOrUrl: string): string {
  const trimmed = domainOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed) || /^\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
      return url.hostname;
    } catch {
      // fall through to raw string
    }
  }
  return trimmed;
}

/**
 * Derive the plugin token string from a company domain or URL without checking
 * whether it is registered as a `Site` value. Used to build clear error messages
 * when a domain cannot be resolved.
 *
 * Rule (Spec 5069):
 * 1. Lower-case and trim.
 * 2. Strip a leading `www.` and any scheme/path.
 * 3. Apply hardcoded exceptions (`divergent.us` → `divergent`, `nuro.ai` → `nuro`).
 * 4. Strip a trailing `.com`.
 * 5. Replace every remaining `.` with `_`.
 */
export function deriveSiteToken(domainOrUrl: string): string {
  let host = extractHost(domainOrUrl).toLowerCase();
  host = host.replace(/^www\./i, '');

  const exception = DOMAIN_TO_TOKEN_EXCEPTIONS[host];
  if (exception) {
    return exception;
  }

  if (host.endsWith('.com')) {
    host = host.slice(0, -4);
  }

  return host.replace(/\./g, '_');
}

/**
 * Derive a registered `Site` token from a company domain or URL.
 *
 * Returns `undefined` when the derived token is not a registered `Site` value.
 *
 * Examples:
 * - `boomsupersonic.com` → `boomsupersonic`
 * - `hyl.io` → `hyl_io`
 * - `https://www.boomsupersonic.com/careers` → `boomsupersonic`
 */
export function siteFromDomain(domainOrUrl: string): Site | undefined {
  const token = deriveSiteToken(domainOrUrl);
  return (Object.values(Site) as string[]).find((s) => s === token) as Site | undefined;
}
