import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Logger } from '@nestjs/common';

import { CRAWL_ENV, CRAWL_PRESETS } from './defaults';
import {
  CALLER_OVERRIDE_POLICIES,
  CRAWL_PRESET_NAMES,
  coerceBoolean,
  coerceCrawlField,
  coerceEnum,
  describeValue,
  expandUserAgentValue,
  hasOwn,
  isCommentKey,
  isUnsafeKey,
  normalizeHostPattern,
  normalizeOverride,
  sanitizeContact,
  sanitizeHeaderValue,
} from './policy-schema';
import { CrawlPolicy, CrawlPolicyEnvConfig, CrawlPolicyFile, CrawlPolicyOverride } from './types';

const logger = new Logger('CrawlPolicy');

/**
 * Pre-1690 retry variables (`apps/api/src/config/configuration.ts`). Still
 * honoured (Spec 1690 §4.1): `RETRY_DEFAULT_*` map into the env-global layer
 * **only when explicitly set** (an `EVER_JOBS_CRAWL_*` equivalent wins), and
 * `RETRY_PER_SOURCE` maps into the operator-site layer (an
 * `EVER_JOBS_CRAWL_POLICIES`/`_POLICY_FILE` site entry wins per field).
 */
export const LEGACY_RETRY_ENV = {
  RETRIES: 'RETRY_DEFAULT_RETRIES',
  DELAY_MS: 'RETRY_DEFAULT_DELAY_MS',
  BACKOFF: 'RETRY_DEFAULT_BACKOFF',
  PER_SOURCE: 'RETRY_PER_SOURCE',
} as const;

/** `RETRY_PER_SOURCE` entry keys → `CrawlPolicy` fields. */
const LEGACY_PER_SOURCE_KEYS: Record<string, keyof CrawlPolicy> = {
  retries: 'retries',
  delayMs: 'retryBaseDelayMs',
  backoff: 'retryBackoff',
  maxDelayMs: 'retryMaxDelayMs',
};

/**
 * Process-wide switches added after the Spec 1690 contract (`CRAWL_ENV`). Each
 * defaults to the documented behaviour of the preset in force, so the `legacy`
 * preset stays the exact pre-1690 behaviour and every piece of it can still be
 * turned back on (or off) on its own.
 */
export const CRAWL_EXTRA_ENV = {
  /**
   * Apply `BUILTIN_HOST_POLICIES` (layer 3). Default `true`; `false` under the
   * `legacy` preset (pre-1690 had no per-host limits).
   */
  BUILTIN_HOSTS: 'EVER_JOBS_CRAWL_BUILTIN_HOSTS',
  /**
   * Apply plugins' `@SourcePlugin({ crawl })` manifests (layer 4, manifest part;
   * the options a plugin passes to `createHttpClient` always apply). Default
   * `true`; `false` under the `legacy` preset.
   */
  PLUGIN_MANIFESTS: 'EVER_JOBS_CRAWL_PLUGIN_MANIFESTS',
  /**
   * Whether a search caller's `proxies` are used: `any` or `none`. Default `any`
   * when `EVER_JOBS_CRAWL_CALLER_OVERRIDES` is `any`, else `none`.
   */
  CALLER_PROXIES: 'EVER_JOBS_CRAWL_CALLER_PROXIES',
  /**
   * Use `DEFAULT_PROXIES` when `EVER_JOBS_CRAWL_PROXIES` is unset. Default
   * `true`; `false` under the `legacy` preset (pre-1690 parsed it and never used it).
   */
  DEFAULT_PROXIES_FALLBACK: 'EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK',
  /**
   * Put browser navigations (`BrowserPool.navigate`) under the crawl policy:
   * egress guard, robots.txt, a host-limiter slot, the scrape's abort, and
   * 429/503 back-off. Default `true`; `false` under the `legacy` preset
   * (pre-1690 pages navigated with a plain `page.goto`, which `false` restores).
   */
  BROWSER_NAVIGATION: 'EVER_JOBS_CRAWL_BROWSER_NAVIGATION',
} as const;

/** Values of `EVER_JOBS_CRAWL_CALLER_PROXIES`. */
export type CallerProxiesPolicy = 'any' | 'none';

const CALLER_PROXIES_POLICIES: readonly CallerProxiesPolicy[] = ['any', 'none'];

/**
 * What `readCrawlPolicyEnv` returns: the contract shape plus the operator contact,
 * which the resolver needs to expand a `default` UA keyword set at any layer, and
 * the post-contract switches (`CRAWL_EXTRA_ENV`).
 */
export interface ParsedCrawlPolicyEnv extends CrawlPolicyEnvConfig {
  /** `EVER_JOBS_CRAWL_CONTACT`, sanitised for use inside the UA comment. */
  contact?: string;
  /** `EVER_JOBS_CRAWL_BUILTIN_HOSTS` (missing on a hand-built config = `true`, except under `legacy`). */
  builtinHosts?: boolean;
  /** `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS` (missing on a hand-built config = `true`, except under `legacy`). */
  pluginManifests?: boolean;
  /** `EVER_JOBS_CRAWL_CALLER_PROXIES` (missing = derived from `callerOverrides`). */
  callerProxies?: CallerProxiesPolicy;
  /** `EVER_JOBS_CRAWL_BROWSER_NAVIGATION` (missing on a hand-built config = `true`, except under `legacy`). */
  browserNavigation?: boolean;
}

/**
 * Whether the builtin-host layer applies under `env` (`EVER_JOBS_CRAWL_BUILTIN_HOSTS`;
 * for a hand-built config without the field: off under `legacy`, else on).
 */
export function crawlBuiltinHostsEnabled(env: CrawlPolicyEnvConfig): boolean {
  const value = (env as ParsedCrawlPolicyEnv).builtinHosts;
  return typeof value === 'boolean' ? value : env.preset !== 'legacy';
}

/**
 * Whether plugin manifests (`@SourcePlugin({ crawl })`) apply under `env`
 * (`EVER_JOBS_CRAWL_PLUGIN_MANIFESTS`; for a hand-built config without the field:
 * off under `legacy`, else on).
 */
export function crawlPluginManifestsEnabled(env: CrawlPolicyEnvConfig): boolean {
  const value = (env as ParsedCrawlPolicyEnv).pluginManifests;
  return typeof value === 'boolean' ? value : env.preset !== 'legacy';
}

/**
 * Whether `BrowserPool.navigate` applies the crawl policy under `env`
 * (`EVER_JOBS_CRAWL_BROWSER_NAVIGATION`; for a hand-built config without the
 * field: off under `legacy`, else on). Off = a plain `page.goto`.
 */
export function crawlBrowserNavigationEnabled(env: CrawlPolicyEnvConfig): boolean {
  const value = (env as ParsedCrawlPolicyEnv).browserNavigation;
  return typeof value === 'boolean' ? value : env.preset !== 'legacy';
}

/**
 * Whether a search caller's `proxies` may be used under `env`
 * (`EVER_JOBS_CRAWL_CALLER_PROXIES`; default `any` only when caller overrides are `any`).
 */
export function crawlCallerProxiesAllowed(env: CrawlPolicyEnvConfig): boolean {
  const value = (env as ParsedCrawlPolicyEnv).callerProxies;
  if (value === 'any' || value === 'none') return value === 'any';
  return env.callerOverrides === undefined || env.callerOverrides === 'any';
}

/**
 * Plain `EVER_JOBS_CRAWL_*` variable → policy field. `userAgent` is handled
 * separately (keyword expansion + contact).
 */
const ENV_FIELDS: ReadonlyArray<readonly [string, keyof CrawlPolicy]> = [
  [CRAWL_ENV.USER_AGENT_MODE, 'userAgentMode'],
  [CRAWL_ENV.FROM, 'from'],
  [CRAWL_ENV.STRIP_CLIENT_HINTS, 'stripClientHints'],
  [CRAWL_ENV.PROXY_ROTATION, 'proxyRotation'],
  [CRAWL_ENV.RATE_SCOPE, 'rateLimitScope'],
  [CRAWL_ENV.MAX_CONCURRENT_PER_HOST, 'maxConcurrentPerHost'],
  [CRAWL_ENV.MIN_INTERVAL_MS, 'minIntervalMs'],
  [CRAWL_ENV.JITTER_MS, 'jitterMs'],
  [CRAWL_ENV.MAX_QUEUE_WAIT_MS, 'maxQueueWaitMs'],
  [CRAWL_ENV.ADAPTIVE, 'adaptiveThrottle'],
  [CRAWL_ENV.RETRIES, 'retries'],
  [CRAWL_ENV.RETRY_STATUSES, 'retryStatuses'],
  [CRAWL_ENV.RETRY_BACKOFF, 'retryBackoff'],
  [CRAWL_ENV.RETRY_BASE_DELAY_MS, 'retryBaseDelayMs'],
  [CRAWL_ENV.RETRY_MAX_DELAY_MS, 'retryMaxDelayMs'],
  [CRAWL_ENV.RETRY_JITTER, 'retryJitter'],
  [CRAWL_ENV.RETRY_ON_NETWORK_ERROR, 'retryOnNetworkError'],
  [CRAWL_ENV.RESPECT_RETRY_AFTER, 'respectRetryAfter'],
  [CRAWL_ENV.MAX_RETRY_AFTER_MS, 'maxRetryAfterMs'],
  [CRAWL_ENV.RETRY_AFTER_OVER_MAX, 'retryAfterOverMax'],
  [CRAWL_ENV.THROTTLE_RETRY_DELAY_MS, 'throttleRetryDelayMs'],
  [CRAWL_ENV.ROBOTS_TXT, 'robotsTxt'],
  [CRAWL_ENV.BLOCK_PRIVATE_NETWORKS, 'blockPrivateNetworks'],
  [CRAWL_ENV.DISCOVERY, 'discovery'],
];

/** `RETRY_DEFAULT_*` → field, applied only when the `EVER_JOBS_CRAWL_*` twin is unset. */
const LEGACY_GLOBAL_FIELDS: ReadonlyArray<readonly [string, keyof CrawlPolicy]> = [
  [LEGACY_RETRY_ENV.RETRIES, 'retries'],
  [LEGACY_RETRY_ENV.DELAY_MS, 'retryBaseDelayMs'],
  [LEGACY_RETRY_ENV.BACKOFF, 'retryBackoff'],
];

/** Every environment variable `readCrawlPolicyEnv` reads (docs, tests, config dumps). */
export const CRAWL_POLICY_ENV_VARS: readonly string[] = [
  ...Object.values(CRAWL_ENV),
  ...Object.values(CRAWL_EXTRA_ENV),
  ...Object.values(LEGACY_RETRY_ENV),
];

/** `none`/`off`/`direct` in `EVER_JOBS_CRAWL_PROXIES` = no proxies, and do not fall back to `DEFAULT_PROXIES`. */
const NO_PROXIES = new Set(['none', 'off', 'direct']);

let cached: ParsedCrawlPolicyEnv | undefined;

/**
 * Parse every `EVER_JOBS_CRAWL_*` variable (names in `CRAWL_ENV`) into a
 * `CrawlPolicyEnvConfig`. Invalid values never throw: they are skipped and
 * reported in `warnings`. When `env` is omitted, `process.env` is read once and
 * cached (see `resetCrawlPolicyEnvCache`).
 *
 * The `process.env` parse (including the policy file) happens once per process:
 * `HttpClient` calls this per request, and reading ~40 variables from
 * `process.env` costs ~0.1 ms per call on Windows. After changing the
 * environment at runtime (tests), call `resetCrawlPolicyEnvCache()`. Warnings of
 * a `process.env` parse are logged once through the Nest `Logger`. Passing an
 * explicit `env` object parses it fresh, uncached and silently. Treat the
 * returned object as read-only — it is shared.
 *
 * Spec 1690 — lane B1.
 */
export function readCrawlPolicyEnv(env?: NodeJS.ProcessEnv): ParsedCrawlPolicyEnv {
  if (env !== undefined && env !== process.env) return parseCrawlPolicyEnv(env);
  if (cached) return cached;

  const config = parseCrawlPolicyEnv(process.env);
  for (const warning of config.warnings) logger.warn(warning);
  cached = config;
  return config;
}

/** Drop the cached `process.env` parse (tests, or after changing env at runtime). */
export function resetCrawlPolicyEnvCache(): void {
  cached = undefined;
}

/**
 * Expand a configured UA: keywords (`default`, `everjobs`, `browser`, `legacy`) map
 * to `USER_AGENT_KEYWORDS`; a `contact` is inserted into the default UA's comment,
 * e.g. `Mozilla/5.0 (compatible; EverJobs/1.0; +https://...; ops@acme.example)`.
 *
 * Keywords are case-insensitive. Empty/whitespace → the default UA. The literal
 * default UA string is treated like the `default` keyword (gets the contact).
 * Any other string is returned as-is, minus characters an HTTP header cannot
 * carry (CR/LF and other control characters). The contact is sanitised the same
 * way and loses any parentheses (they would unbalance the UA comment).
 */
export function expandUserAgent(value: string | undefined, contact?: string): string {
  return expandUserAgentValue(value, contact);
}

/**
 * Parse a proxy list: a JSON array of strings, or a comma / whitespace separated
 * list. Empty entries are dropped; order and duplicates are kept (a duplicate is
 * a deliberate weight in round-robin).
 */
export function parseCrawlProxyList(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let items: unknown[] | undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = undefined;
    }
  }
  if (items === undefined) items = trimmed.split(/[\s,]+/);
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => sanitizeHeaderValue(item))
    .filter((item) => item.length > 0);
}

// ── internals ────────────────────────────────────────────────────────────────

/** A variable's trimmed value; unset and empty/whitespace both read as `undefined`. */
function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseCrawlPolicyEnv(env: NodeJS.ProcessEnv): ParsedCrawlPolicyEnv {
  const warnings: string[] = [];
  const global: CrawlPolicyOverride = {};
  const globalRecord = global as Record<string, unknown>;

  // Preset.
  let preset = CRAWL_PRESET_NAMES[0];
  const rawPreset = readVar(env, CRAWL_ENV.PRESET);
  if (rawPreset !== undefined) {
    const result = coerceEnum(rawPreset, CRAWL_PRESET_NAMES);
    if (result.value !== undefined) preset = result.value;
    else warnings.push(`${CRAWL_ENV.PRESET}: ${result.problem}; using "${preset}"`);
  }

  // Identity: contact + UA (keywords expanded, contact inserted into the default UA).
  let contact: string | undefined;
  const rawContact = readVar(env, CRAWL_ENV.CONTACT);
  if (rawContact !== undefined) {
    contact = sanitizeContact(rawContact);
    if (contact === undefined) warnings.push(`${CRAWL_ENV.CONTACT}: nothing usable after removing unsafe characters; ignored`);
  }
  const presetUa = CRAWL_PRESETS[preset].userAgent;
  let uaInForce = presetUa;
  const rawUa = readVar(env, CRAWL_ENV.USER_AGENT);
  if (rawUa !== undefined) {
    const clean = sanitizeHeaderValue(rawUa);
    if (!clean) {
      warnings.push(`${CRAWL_ENV.USER_AGENT}: nothing usable after removing unsafe characters; ignored`);
    } else {
      if (clean !== rawUa) warnings.push(`${CRAWL_ENV.USER_AGENT}: characters not allowed in an HTTP header were removed`);
      uaInForce = clean;
      global.userAgent = expandUserAgentValue(clean, contact);
    }
  } else if (contact !== undefined && takesContact(presetUa)) {
    global.userAgent = expandUserAgentValue(presetUa, contact);
  }
  if (contact !== undefined && !takesContact(uaInForce)) {
    warnings.push(
      `${CRAWL_ENV.CONTACT}: the configured User-Agent is not the Ever Jobs default, so the contact is not inserted ` +
        'into it (it is still applied wherever a layer sets the "default" keyword)',
    );
  }

  // Every other scalar knob.
  for (const [name, field] of ENV_FIELDS) {
    const raw = readVar(env, name);
    if (raw === undefined) continue;
    const result = coerceCrawlField(field, raw);
    if (result.problem !== undefined) {
      warnings.push(`${name}: ${result.problem}; ignored`);
      continue;
    }
    if (result.note !== undefined) warnings.push(`${name}: ${result.note}`);
    globalRecord[field] = result.value;
  }

  // Pre-1690 RETRY_DEFAULT_*: only when explicitly set, and only when the EVER_JOBS_CRAWL_* twin is not.
  for (const [name, field] of LEGACY_GLOBAL_FIELDS) {
    const raw = readVar(env, name);
    if (raw === undefined || globalRecord[field] !== undefined) continue;
    const result = coerceCrawlField(field, raw);
    if (result.problem !== undefined) {
      warnings.push(`${name}: ${result.problem}; ignored`);
      continue;
    }
    if (result.note !== undefined) warnings.push(`${name}: ${result.note}`);
    globalRecord[field] = result.value;
  }

  // Operator per-site / per-host policies: RETRY_PER_SOURCE < policy file < EVER_JOBS_CRAWL_POLICIES (per field).
  const policies: Required<CrawlPolicyFile> = { sites: {}, hosts: {} };
  mergeRetryPerSource(policies, readVar(env, LEGACY_RETRY_ENV.PER_SOURCE), warnings);
  const policyFile = readVar(env, CRAWL_ENV.POLICY_FILE);
  if (policyFile !== undefined) {
    const parsed = readPolicyFile(policyFile, warnings);
    if (parsed !== undefined) mergePolicyFile(policies, parsed, `${CRAWL_ENV.POLICY_FILE} (${policyFile})`, warnings);
  }
  const policiesJson = readVar(env, CRAWL_ENV.POLICIES);
  if (policiesJson !== undefined) {
    const parsed = parseJson(policiesJson, CRAWL_ENV.POLICIES, warnings);
    if (parsed !== undefined) mergePolicyFile(policies, parsed, CRAWL_ENV.POLICIES, warnings);
  }

  // Caller override policy.
  let callerOverrides = CALLER_OVERRIDE_POLICIES[0];
  const rawCaller = readVar(env, CRAWL_ENV.CALLER_OVERRIDES);
  if (rawCaller !== undefined) {
    const result = coerceEnum(rawCaller, CALLER_OVERRIDE_POLICIES);
    if (result.value !== undefined) callerOverrides = result.value;
    else warnings.push(`${CRAWL_ENV.CALLER_OVERRIDES}: ${result.problem}; using "${callerOverrides}"`);
  }

  // Deadline abort.
  let abortOnDeadline = true;
  const rawAbort = readVar(env, CRAWL_ENV.ABORT_ON_DEADLINE);
  if (rawAbort !== undefined) {
    const result = coerceBoolean(rawAbort);
    if (result.value !== undefined) abortOnDeadline = result.value;
    else warnings.push(`${CRAWL_ENV.ABORT_ON_DEADLINE}: ${result.problem}; using ${abortOnDeadline}`);
  }

  // Post-contract switches (CRAWL_EXTRA_ENV): default on, off under `legacy`.
  const legacy = preset === 'legacy';
  const builtinHosts = readBooleanSwitch(env, CRAWL_EXTRA_ENV.BUILTIN_HOSTS, !legacy, warnings);
  const pluginManifests = readBooleanSwitch(env, CRAWL_EXTRA_ENV.PLUGIN_MANIFESTS, !legacy, warnings);
  const defaultProxiesFallback = readBooleanSwitch(env, CRAWL_EXTRA_ENV.DEFAULT_PROXIES_FALLBACK, !legacy, warnings);
  const browserNavigation = readBooleanSwitch(env, CRAWL_EXTRA_ENV.BROWSER_NAVIGATION, !legacy, warnings);
  let callerProxies: CallerProxiesPolicy = callerOverrides === 'any' ? 'any' : 'none';
  const rawCallerProxies = readVar(env, CRAWL_EXTRA_ENV.CALLER_PROXIES);
  if (rawCallerProxies !== undefined) {
    const result = coerceEnum(rawCallerProxies, CALLER_PROXIES_POLICIES);
    if (result.value !== undefined) callerProxies = result.value;
    else warnings.push(`${CRAWL_EXTRA_ENV.CALLER_PROXIES}: ${result.problem}; using "${callerProxies}"`);
  }

  // Proxies: EVER_JOBS_CRAWL_PROXIES, else DEFAULT_PROXIES (unless the fallback is off).
  let proxies: string[] = [];
  const rawProxies = readVar(env, CRAWL_ENV.PROXIES);
  if (rawProxies !== undefined && NO_PROXIES.has(rawProxies.toLowerCase())) {
    proxies = [];
  } else {
    proxies = parseCrawlProxyList(rawProxies);
    if (rawProxies !== undefined && proxies.length === 0) {
      warnings.push(
        `${CRAWL_ENV.PROXIES}: no usable proxy in the list; ` +
          (defaultProxiesFallback ? `falling back to ${CRAWL_ENV.LEGACY_PROXIES}` : 'using none'),
      );
    }
    const legacyList = readVar(env, CRAWL_ENV.LEGACY_PROXIES);
    if (proxies.length === 0 && defaultProxiesFallback) proxies = parseCrawlProxyList(legacyList);
    else if (proxies.length === 0 && legacyList !== undefined) {
      warnings.push(
        `${CRAWL_ENV.LEGACY_PROXIES} is not used (${CRAWL_EXTRA_ENV.DEFAULT_PROXIES_FALLBACK}=false` +
          `${legacy ? ', the legacy preset default' : ''}); set ${CRAWL_ENV.PROXIES} to use a proxy list`,
      );
    }
  }

  const config: ParsedCrawlPolicyEnv = {
    preset,
    global,
    policies,
    callerOverrides,
    proxies,
    abortOnDeadline,
    warnings,
    builtinHosts,
    pluginManifests,
    callerProxies,
    browserNavigation,
  };
  if (contact !== undefined) config.contact = contact;
  return config;
}

/** A boolean switch: unset → `fallback`; invalid → `fallback` with a warning. */
function readBooleanSwitch(env: NodeJS.ProcessEnv, name: string, fallback: boolean, warnings: string[]): boolean {
  const raw = readVar(env, name);
  if (raw === undefined) return fallback;
  const result = coerceBoolean(raw);
  if (result.value !== undefined) return result.value;
  warnings.push(`${name}: ${result.problem}; using ${fallback}`);
  return fallback;
}

/** Whether `ua` (a keyword or string) is the Ever Jobs default, i.e. the contact is inserted into it. */
function takesContact(ua: string): boolean {
  return expandUserAgentValue(ua, 'x') !== expandUserAgentValue(ua);
}

function parseJson(text: string, source: string, warnings: string[]): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    warnings.push(`${source}: invalid JSON (${(err as Error).message}); ignored`);
    return undefined;
  }
}

function readPolicyFile(path: string, warnings: string[]): unknown {
  let text: string;
  try {
    text = readFileSync(resolvePath(path), 'utf8');
  } catch (err) {
    warnings.push(`${CRAWL_ENV.POLICY_FILE}: cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); ignored`);
    return undefined;
  }
  return parseJson(text, `${CRAWL_ENV.POLICY_FILE} (${path})`, warnings);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge a `{ sites, hosts }` document into `target`, field by field (later documents win). */
function mergePolicyFile(target: Required<CrawlPolicyFile>, raw: unknown, source: string, warnings: string[]): void {
  if (!isPlainObject(raw)) {
    warnings.push(`${source}: expected a JSON object { "sites": {...}, "hosts": {...} }, got ${describeValue(raw)}; ignored`);
    return;
  }
  for (const key of Object.keys(raw)) {
    if (key === 'sites' || key === 'hosts') mergeSection(target[key], raw[key], key, source, warnings);
    else if (!isCommentKey(key)) warnings.push(`${source}: unknown key "${key}" (expected "sites" and/or "hosts"); ignored`);
  }
}

function mergeSection(
  target: Record<string, CrawlPolicyOverride>,
  raw: unknown,
  kind: 'sites' | 'hosts',
  source: string,
  warnings: string[],
): void {
  if (raw === undefined || raw === null) return;
  if (!isPlainObject(raw)) {
    warnings.push(`${source}: "${kind}" must be an object keyed by ${kind === 'sites' ? 'site' : 'host pattern'}; ignored`);
    return;
  }
  for (const rawKey of Object.keys(raw)) {
    if (isCommentKey(rawKey)) continue;
    const key = kind === 'sites' ? normalizeSiteKey(rawKey) : normalizeHostPattern(rawKey);
    if (key === undefined || isUnsafeKey(key)) {
      warnings.push(
        `${source}: invalid ${kind === 'sites' ? 'site' : 'host pattern'} "${rawKey}"` +
          (kind === 'hosts' ? ' (expected an exact host, "*.suffix" or "*")' : '') +
          '; ignored',
      );
      continue;
    }
    const { value, warnings: fieldWarnings } = normalizeOverride(raw[rawKey]);
    for (const w of fieldWarnings) warnings.push(`${source}: ${kind}["${rawKey}"].${w}`);
    target[key] = { ...(hasOwn(target, key) ? target[key] : {}), ...value };
  }
}

function normalizeSiteKey(key: string): string | undefined {
  const site = key.trim().toLowerCase();
  return site || undefined;
}

/** `RETRY_PER_SOURCE` = `{ "<site>": { retries, delayMs, backoff, maxDelayMs } }` → `sites`. */
function mergeRetryPerSource(target: Required<CrawlPolicyFile>, raw: string | undefined, warnings: string[]): void {
  if (raw === undefined) return;
  const parsed = parseJson(raw, LEGACY_RETRY_ENV.PER_SOURCE, warnings);
  if (parsed === undefined) return;
  if (!isPlainObject(parsed)) {
    warnings.push(`${LEGACY_RETRY_ENV.PER_SOURCE}: expected a JSON object keyed by site, got ${describeValue(parsed)}; ignored`);
    return;
  }
  const sites: Record<string, unknown> = {};
  for (const site of Object.keys(parsed)) {
    const entry = parsed[site];
    if (!isPlainObject(entry)) {
      sites[site] = entry; // normalizeOverride reports it
      continue;
    }
    const mapped: Record<string, unknown> = {};
    for (const key of Object.keys(entry)) {
      mapped[hasOwn(LEGACY_PER_SOURCE_KEYS, key) ? LEGACY_PER_SOURCE_KEYS[key] : key] = entry[key];
    }
    sites[site] = mapped;
  }
  mergePolicyFile(target, { sites }, LEGACY_RETRY_ENV.PER_SOURCE, warnings);
}
