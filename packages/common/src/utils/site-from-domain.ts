import { Site } from '@ever-jobs/models';

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
 * Normalize a company domain or URL to a bare, comparable host: scheme and path
 * stripped, lower-cased, leading `www.` removed.
 *
 * Shared by `deriveSiteToken` and by the plugin registry's declared-domain index
 * (Spec 5086), so a plugin's declaration and a caller's domain can never
 * disagree about what the host is.
 */
export function normalizeCompanyHost(domainOrUrl: string): string {
  return extractHost(domainOrUrl).toLowerCase().replace(/^www\./i, '');
}

/**
 * Derive the plugin token string from a company domain or URL without checking
 * whether it is registered as a `Site` value. Used to build clear error messages
 * when a domain cannot be resolved.
 *
 * Rule (Spec 5069):
 * 1. Lower-case and trim.
 * 2. Strip a leading `www.` and any scheme/path.
 * 3. Strip a trailing `.com`.
 * 4. Replace every remaining `.` with `_`.
 *
 * A plugin whose token does not follow this rule declares its domains instead
 * (`IPluginMetadata.companyDomains`, Spec 5086).
 */
export function deriveSiteToken(domainOrUrl: string): string {
  let host = normalizeCompanyHost(domainOrUrl);

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
