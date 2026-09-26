import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { normalizeCompany, normalizeLocation, normalizeTitle } from './normalize';
import { canonicalCountryName, normalizeUsState } from './utils/location-parser';

const logger = new Logger('CanonicalKey');

/** A per-site location as the key sees it — `LocationDto` is assignable. */
export interface CanonicalKeySite {
  city?: string | null;
  state?: string | null;
  /** Country in any form: name, ISO alpha-2/3, or a `Country` enum value. */
  country?: string | null;
  /** Site label; only read for remote tokens ('Remote', 'Work from home'). */
  name?: string | null;
  /** Verbatim source label; only read for remote tokens. */
  text?: string | null;
}

/**
 * Triple of normalised fields that, joined with `|`, defines the canonical
 * identity of a job posting (Spec 003).
 */
export interface CanonicalKeyInput {
  readonly title: string | null | undefined;
  readonly company: string | null | undefined;
  readonly location: string | null | undefined;
  /**
   * Per-site locations when the source carries them (Spec 5123). When
   * non-empty, the location component of the key is built from the sorted
   * set of normalised `city|state|country` triples — the richest site data
   * available — instead of the flattened `location` string. The string is
   * the fallback for sources without per-site data.
   */
  readonly locations?: ReadonlyArray<CanonicalKeySite> | null;
  /**
   * The posting's remote flag (`JobPostDto.isRemote`). With no concrete site
   * (city/state), a remote job keys to the `remote` bucket — the same bucket
   * `normalizeLocation` gives any label with a remote token — so a parsed
   * 'Remote' / 'Remote - US' posting still merges with a source that emits
   * `{ city: 'Remote' }`.
   */
  readonly isRemote?: boolean | null;
}

/** Key-shape options; unset fields take their `EVER_JOBS_CANONICAL_KEY_*` env default. */
export interface CanonicalKeyOptions {
  /**
   * Key a posting with no concrete site to `remote` when it is remote
   * (`isRemote`, or a remote token in the flat label or a site's
   * city/name/text). Default true. False restores the Spec 5123 key, where a
   * parsed 'Remote' keyed to '' and 'Remote - US' to 'united states'.
   * Env: `EVER_JOBS_CANONICAL_KEY_REMOTE_BUCKET`.
   */
  remoteBucket?: boolean;
  /**
   * Rewrite every country ('US', 'USA', 'United States', 'Country.USA') to
   * one canonical name before hashing, in site triples and in the flat
   * label's trailing part, so 'Austin, TX, USA' and
   * `{ city: 'Austin', state: 'TX', country: 'US' }` share a key. Default
   * true. False keeps countries verbatim (the pre-hardening key).
   * Env: `EVER_JOBS_CANONICAL_KEY_NORMALIZE_COUNTRY`.
   */
  normalizeCountry?: boolean;
}

/** Environment variables that set the key's process-wide defaults. */
export const CANONICAL_KEY_ENV = {
  remoteBucket: 'EVER_JOBS_CANONICAL_KEY_REMOTE_BUCKET',
  normalizeCountry: 'EVER_JOBS_CANONICAL_KEY_NORMALIZE_COUNTRY',
} as const;

type ResolvedCanonicalKeyOptions = Required<CanonicalKeyOptions>;

let cachedEnvDefaults: ResolvedCanonicalKeyOptions | null = null;

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') {
    return false;
  }
  logger.warn(
    `Ignoring ${name}=${JSON.stringify(raw)} (expected true/false); using ${fallback}`,
  );
  return fallback;
}

function resolveOptions(
  options?: CanonicalKeyOptions,
): ResolvedCanonicalKeyOptions {
  if (!cachedEnvDefaults) {
    cachedEnvDefaults = {
      remoteBucket: readBooleanEnv(CANONICAL_KEY_ENV.remoteBucket, true),
      normalizeCountry: readBooleanEnv(CANONICAL_KEY_ENV.normalizeCountry, true),
    };
  }
  if (!options) return cachedEnvDefaults;
  return {
    remoteBucket: options.remoteBucket ?? cachedEnvDefaults.remoteBucket,
    normalizeCountry:
      options.normalizeCountry ?? cachedEnvDefaults.normalizeCountry,
  };
}

/**
 * Forget the cached `EVER_JOBS_CANONICAL_KEY_*` defaults so the next key
 * re-reads the environment (read once per process otherwise).
 */
export function resetCanonicalKeyEnvCache(): void {
  cachedEnvDefaults = null;
}

const REMOTE_KEY = 'remote';
const TWO_LETTER_RE = /^[A-Za-z]{2}$/;

/** 'CA' / 'tx' — a 2-letter US state/territory code (never read as a country here). */
function isUsStateCode(value: string): boolean {
  return TWO_LETTER_RE.test(value) && normalizeUsState(value) !== null;
}

function siteCountry(
  country: string | null | undefined,
  opts: ResolvedCanonicalKeyOptions,
): string | null | undefined {
  if (!opts.normalizeCountry || !country) return country;
  return canonicalCountryName(country) ?? country;
}

/**
 * Canonical country in the flat label's trailing comma part. A 2-letter tail
 * that is a US state code is left alone ('San Francisco, CA' keeps meaning
 * California — `normalizeLocation` expands it).
 */
function flatWithCanonicalCountry(location: string): string {
  const cut = location.lastIndexOf(',');
  const tail = location.slice(cut + 1).trim();
  if (!tail || isUsStateCode(tail)) return location;
  const country = canonicalCountryName(tail);
  if (!country) return location;
  return cut < 0 ? country : `${location.slice(0, cut)}, ${country}`;
}

/** A flat label naming only a country ('United States', 'USA') — no site. */
function isCountryOnlyLabel(location: string): boolean {
  const trimmed = location.trim();
  return !isUsStateCode(trimmed) && canonicalCountryName(trimmed) !== null;
}

function hasRemoteToken(value: string | null | undefined): boolean {
  return Boolean(value) && normalizeLocation(value) === REMOTE_KEY;
}

/**
 * Location component of the canonical key.
 *
 * With `locations[]`: each site contributes `normalizeLocation("city, state,
 * country")`; empty triples are dropped; the surviving set is sorted and
 * joined with `;` so site ordering and label punctuation never change the
 * identity of a posting. When no site yields a triple, the flattened
 * `location` string is the fallback — keeping mixed batches (rows with and
 * without `locations[]`) mergeable.
 *
 * Remote bucket: a posting that is remote — `isRemote`, a remote token in the
 * flat label (`normalizeLocation` semantics), or a site that is itself
 * 'Remote' — and has NO concrete site (city/state) keys to `remote`, exactly
 * as `normalizeLocation('Remote, US')` does. So a parsed 'Remote' (no
 * location) or 'Remote - US' (`{ country }` only) matches a source emitting
 * `{ city: 'Remote' }`. With a concrete site the site set wins.
 */
function locationKeyComponent(
  input: CanonicalKeyInput,
  opts: ResolvedCanonicalKeyOptions,
): string {
  const { locations } = input;
  const flat = input.location ?? '';
  // normalizeLocation is the costly step (NFKD) — computed only when needed
  const flatKey = (): string =>
    normalizeLocation(opts.normalizeCountry ? flatWithCanonicalCountry(flat) : flat);

  if (locations && locations.length > 0) {
    const triples = new Set<string>();
    let concreteSite = false;
    let remoteSite = false;
    for (const site of locations) {
      const triple = normalizeLocation(
        [site.city, site.state, siteCountry(site.country, opts)]
          .filter(Boolean)
          .join(', '),
      );
      if (!triple) continue;
      triples.add(triple);
      if (triple === REMOTE_KEY) remoteSite = true;
      else if (site.city || site.state) concreteSite = true;
    }
    if (triples.size > 0) {
      const siteKey = Array.from(triples).sort().join(';');
      if (!opts.remoteBucket || concreteSite) return siteKey;
      // only country-level (or 'Remote') sites: the remote bucket when the
      // posting, its flat label or any site says remote
      const remote =
        remoteSite ||
        input.isRemote === true ||
        locations.some((s) => hasRemoteToken(s.text) || hasRemoteToken(s.name)) ||
        flatKey() === REMOTE_KEY;
      return remote ? REMOTE_KEY : siteKey;
    }
  }

  // flat fallback (no per-site geography)
  const key = flatKey();
  if (!opts.remoteBucket || key === REMOTE_KEY) return key;
  const remote =
    input.isRemote === true ||
    (locations ?? []).some((s) => hasRemoteToken(s.text) || hasRemoteToken(s.name));
  // the flat label is a concrete site unless it is empty or names only a country
  if (remote && (!key || isCountryOnlyLabel(flat))) return REMOTE_KEY;
  return key;
}

/**
 * Build the canonical-key string for a raw job. Pure & deterministic (for a
 * given set of options / env defaults).
 *
 *   canonicalKey({ company: "Acme, Inc.", title: "Sr. SWE", location: "Remote" })
 *   //=> "acme|senior swe|remote"
 *
 * The pipe is a literal separator; pipes inside any normalised field are
 * impossible (`PUNCT_RE` doesn't strip pipes for titles, but `TITLE_NOISE`
 * already replaces them with spaces — so pipes can never appear inside a
 * normalised title; companies and locations never contain pipes).
 */
export function canonicalKey(
  input: CanonicalKeyInput,
  options?: CanonicalKeyOptions,
): string {
  const opts = resolveOptions(options);
  const company = normalizeCompany(input.company ?? '');
  const title = normalizeTitle(input.title ?? '');
  const location = locationKeyComponent(input, opts);
  return `${company}|${title}|${location}`;
}

/**
 * Stable sha-256 (lower-case hex) of the canonical key. This is the
 * `CanonicalJob.canonicalJobId` produced by the dedup engine.
 */
export function canonicalJobId(
  input: CanonicalKeyInput,
  options?: CanonicalKeyOptions,
): string {
  return createHash('sha256')
    .update(canonicalKey(input, options), 'utf8')
    .digest('hex');
}
