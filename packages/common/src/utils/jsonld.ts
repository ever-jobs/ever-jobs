import {
  CompensationDto,
  CompensationInterval,
  getCompensationInterval,
} from '@ever-jobs/models';

/**
 * Shared schema.org `JobPosting` JSON-LD extraction (Spec 5022).
 *
 * Many careers/detail pages embed one or more
 * `<script type="application/ld+json">` blocks containing a schema.org
 * `JobPosting`. This module centralises the (fiddly) work of finding every
 * block, parsing it defensively, unwrapping the common container shapes
 * (single object, array, `@graph`, `ItemList`), and normalising the fields we
 * care about into a flat {@link JobPostingLd}. Plugins consume it JSON-LD-first
 * and fall back to their own HTML parsing for anything it cannot supply.
 *
 * Defensive throughout: malformed blocks are skipped (never thrown), and every
 * field is independently optional, so a partial block still yields whatever it
 * does carry.
 */

/** A normalised pay range pulled from `JobPosting.baseSalary`. */
export interface JobPostingLdSalary {
  minAmount: number | null;
  maxAmount: number | null;
  currency: string | null;
  interval: CompensationInterval | null;
}

/** A normalised location pulled from `JobPosting.jobLocation[].address`. */
export interface JobPostingLdLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
  /** A pre-joined "City, Region, Country" label for text parsers. */
  label: string | null;
}

/** The flattened, normalised view of a schema.org `JobPosting` node. */
export interface JobPostingLd {
  title: string | null;
  description: string | null;
  datePosted: string | null;
  validThrough: string | null;
  /** Raw schema value(s), e.g. `FULL_TIME`; joined with `, ` when an array. */
  employmentType: string | null;
  hiringOrganizationName: string | null;
  /** `hiringOrganization.sameAs` — often the company's own site. */
  hiringOrganizationUrl: string | null;
  /** The canonical posting URL (frequently the ATS detail page). */
  url: string | null;
  /** Apply target from `potentialAction` (ApplyAction), when present. */
  applyUrl: string | null;
  /** `true` when `jobLocationType === 'TELECOMMUTE'`. */
  remote: boolean;
  locations: JobPostingLdLocation[];
  baseSalary: JobPostingLdSalary | null;
}

const SCRIPT_BLOCK_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Find and JSON-parse every `application/ld+json` block in the HTML. Malformed
 * blocks are skipped. Returns the raw parsed values (objects/arrays) in source
 * order — callers that want only `JobPosting`s should use
 * {@link parseJobPostingLd}.
 */
export function extractLdJsonBlocks(html: string): unknown[] {
  if (!html) return [];
  const blocks: unknown[] = [];
  SCRIPT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK_RE.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Skip malformed ld+json blocks.
    }
  }
  return blocks;
}

/**
 * Extract every schema.org `JobPosting` from the page's ld+json blocks,
 * normalised to {@link JobPostingLd}. Handles single-object, array, `@graph`
 * and `ItemList` containers, and `@type` given as a string or an array.
 * Returns `[]` when no `JobPosting` is present.
 */
export function parseJobPostingLd(html: string): JobPostingLd[] {
  const nodes: Record<string, unknown>[] = [];
  for (const block of extractLdJsonBlocks(html)) {
    collectJobPostings(block, nodes);
  }
  return nodes.map(mapJobPosting);
}

/**
 * Normalise an already-parsed schema.org value into a {@link JobPostingLd}.
 *
 * Some ATSes hand back the `JobPosting` JSON-LD as a decoded object (or a JSON
 * string), not embedded in page HTML — e.g. Paycom's detail API carries it in a
 * `googleJobJson` field. This reuses the same defensive container-unwrapping and
 * field mapping as {@link parseJobPostingLd} without round-tripping through a
 * `<script>` wrapper (which would truncate on a literal `</script>` in the body).
 * Accepts an object/array or a JSON string; returns the first `JobPosting` node
 * found, or `null`.
 */
export function jobPostingLdFromNode(
  value: unknown,
): JobPostingLd | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const nodes: Record<string, unknown>[] = [];
  collectJobPostings(parsed, nodes);
  return nodes.length > 0 ? mapJobPosting(nodes[0]) : null;
}

/** Convenience: map a {@link JobPostingLdSalary} to a {@link CompensationDto}. */
export function jobPostingLdToCompensation(
  salary: JobPostingLdSalary | null | undefined,
): CompensationDto | null {
  if (!salary) return null;
  if (salary.minAmount == null && salary.maxAmount == null) return null;
  return new CompensationDto({
    interval: salary.interval ?? undefined,
    minAmount: salary.minAmount ?? undefined,
    maxAmount: salary.maxAmount ?? undefined,
    currency: salary.currency ?? undefined,
  });
}

/** Recursively walk a parsed ld+json value, collecting `JobPosting` nodes. */
function collectJobPostings(
  value: unknown,
  out: Record<string, unknown>[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostings(item, out);
    return;
  }
  if (!isObject(value)) return;

  if (typeHas(value['@type'], 'JobPosting')) {
    out.push(value);
    return;
  }
  // Container shapes that wrap postings.
  if (Array.isArray(value['@graph'])) {
    collectJobPostings(value['@graph'], out);
  }
  if (Array.isArray(value.itemListElement)) {
    for (const element of value.itemListElement) {
      // `ItemList` entries are usually `ListItem { item: JobPosting }`, but some
      // sites inline the posting directly as the element.
      if (isObject(element) && element.item !== undefined) {
        collectJobPostings(element.item, out);
      } else {
        collectJobPostings(element, out);
      }
    }
  }
}

function mapJobPosting(node: Record<string, unknown>): JobPostingLd {
  return {
    title: firstString(node.title) ?? firstString(node.name),
    description: firstString(node.description),
    datePosted: firstString(node.datePosted),
    validThrough: firstString(node.validThrough),
    employmentType: joinStrings(node.employmentType),
    hiringOrganizationName: orgName(node.hiringOrganization),
    hiringOrganizationUrl: orgUrl(node.hiringOrganization),
    url: firstString(node.url),
    applyUrl: applyUrl(node.potentialAction),
    remote: firstString(node.jobLocationType)?.toUpperCase() === 'TELECOMMUTE',
    locations: mapLocations(node.jobLocation),
    baseSalary: mapSalary(node.baseSalary),
  };
}

function mapLocations(value: unknown): JobPostingLdLocation[] {
  const out: JobPostingLdLocation[] = [];
  for (const place of asArray(value)) {
    if (!isObject(place)) continue;
    for (const address of asArray(place.address)) {
      if (!isObject(address)) continue;
      const city = firstString(address.addressLocality);
      const region = firstString(address.addressRegion);
      const country = countryName(address.addressCountry);
      const postalCode = firstString(address.postalCode);
      if (!city && !region && !country && !postalCode) continue;
      const label =
        [city, region, country].filter((p): p is string => !!p).join(', ') ||
        null;
      out.push({ city, region, country, postalCode, label });
    }
  }
  return out;
}

function mapSalary(value: unknown): JobPostingLdSalary | null {
  if (!isObject(value)) return null;
  const currency =
    firstString(value.currency) ?? firstString(value.salaryCurrency);
  const interval = payInterval(value.unitText);

  const amount = value.value;
  if (isObject(amount)) {
    const min = toNumber(amount.minValue);
    const max = toNumber(amount.maxValue);
    const single = toNumber(amount.value);
    const unit = interval ?? payInterval(amount.unitText);
    if (min != null || max != null) {
      return { minAmount: min, maxAmount: max, currency, interval: unit };
    }
    if (single != null) {
      return {
        minAmount: single,
        maxAmount: single,
        currency,
        interval: unit,
      };
    }
    return null;
  }

  const single = toNumber(amount);
  if (single != null) {
    return { minAmount: single, maxAmount: single, currency, interval };
  }
  return null;
}

function payInterval(value: unknown): CompensationInterval | null {
  const text = firstString(value);
  return text ? getCompensationInterval(text) : null;
}

function orgName(org: unknown): string | null {
  if (typeof org === 'string') return org.trim() || null;
  if (isObject(org)) return firstString(org.name);
  return null;
}

function orgUrl(org: unknown): string | null {
  if (!isObject(org)) return null;
  return firstString(org.sameAs) ?? firstString(org.url);
}

function applyUrl(action: unknown): string | null {
  for (const act of asArray(action)) {
    if (!isObject(act)) continue;
    if (!typeHas(act['@type'], 'ApplyAction')) continue;
    const target = act.target;
    if (typeof target === 'string') return target;
    if (isObject(target)) {
      return firstString(target.url) ?? firstString(target.urlTemplate);
    }
  }
  return null;
}

function countryName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (isObject(value)) return firstString(value.name);
  return null;
}

/** True when a schema `@type` (string or array) includes `wanted`. */
function typeHas(type: unknown, wanted: string): boolean {
  if (typeof type === 'string') return type === wanted;
  if (Array.isArray(type)) return type.includes(wanted);
  return false;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** First non-empty string from a string or array of strings. */
function firstString(value: unknown): string | null {
  for (const item of asArray(value)) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return null;
}

/** Join a string-or-array schema value into one `, `-delimited string. */
function joinStrings(value: unknown): string | null {
  const parts = asArray(value)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  return parts.length > 0 ? parts.join(', ') : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
