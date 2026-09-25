import { BUILTIN_HOST_POLICIES, CRAWL_PRESETS } from './defaults';
import {
  CRAWL_EXTRA_ENV,
  ParsedCrawlPolicyEnv,
  crawlBuiltinHostsEnabled,
  crawlPluginManifestsEnabled,
  expandUserAgent,
  readCrawlPolicyEnv,
} from './env';
import {
  CALLER_OVERRIDE_POLICIES,
  CRAWL_POLICY_FIELDS,
  hasOwn,
  hostMatches,
  hostPatternSpecificity,
  isCrawlPolicyField,
  normalizeHostName,
  normalizeOverride,
} from './policy-schema';
import {
  CallerOverridePolicy,
  CrawlPolicy,
  CrawlPolicyEnvConfig,
  CrawlPolicyLayer,
  CrawlPolicyOverride,
  CrawlPolicyResolveInput,
  CrawlPreset,
  PluginCrawlPolicy,
  ResolvedCrawlPolicy,
} from './types';

export {
  CRAWL_POLICY_FIELDS,
  CRAWL_POLICY_FIELD_SPECS,
  MAX_CRAWL_POLICY_INT,
  isCrawlPolicyField,
  normalizeHostName as normalizeCrawlHostName,
  normalizeHostPattern as normalizeCrawlHostPattern,
} from './policy-schema';
export type { CrawlPolicyFieldSpec } from './policy-schema';

/**
 * `resolveCrawlPolicy` plus the metadata that is not a policy field — what the
 * `GET /api/sources/:site/crawl-policy` endpoint and diagnostics show.
 */
export interface CrawlPolicyExplanation {
  policy: ResolvedCrawlPolicy;
  preset: CrawlPreset;
  callerOverrides: CallerOverridePolicy;
  /** The plugin's `userAgentReason`, when its `userAgentMode: 'plugin'` opt-in is in effect. */
  userAgentReason?: string;
  /** Caller fields refused by `EVER_JOBS_CRAWL_CALLER_OVERRIDES` (or not policy fields). */
  callerRejected: string[];
  /** Builtin host policy applied (the normalised host), if any. */
  builtinHost?: string;
  /** Operator site key applied, if any. */
  operatorSite?: string;
  /** Operator host patterns applied, least specific first (the last one wins per field). */
  operatorHostPatterns: string[];
  /** Non-fatal notes: invalid layer values dropped, a plugin UA opt-in ignored under `strict`, … */
  notes: string[];
}

/**
 * Merge the policy layers (see `types.ts` header) for one request.
 *
 *   preset → env-global → builtin-host → plugin (manifest, then explicit
 *   `createHttpClient` options) → operator-site → operator-host → caller
 *
 * - Every layer is validated (`normalizeCrawlOverride`); `undefined` fields do not
 *   override. Any `userAgent` goes through `expandUserAgent` with the operator
 *   contact.
 * - builtin-host: `BUILTIN_HOST_POLICIES[host]` (exact host), unless
 *   `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (the `legacy` preset's default).
 * - plugin: the manifest applies unless `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false`
 *   (the `legacy` preset's default); the explicit options always apply. When the
 *   layers below pin `userAgentMode: 'strict'`, a plugin cannot relax it (Spec
 *   1690 §4.2 — `strict` = "no exceptions"); its request is noted and dropped. A
 *   plugin-layer `userAgent` is never the configured UA — it is a *declared* UA
 *   (noted and dropped here; `HttpClient`/`BrowserPool` decide whether it is sent).
 * - `legacy` preset: `maxRetryAfterMs` follows `retryMaxDelayMs` unless a layer
 *   set it (the single pre-1690 ceiling).
 * - operator-host: EVERY matching pattern applies, least specific first (`*` <
 *   shorter `*.suffix` < longer `*.suffix` < exact host), so the most specific
 *   pattern wins field by field.
 * - caller: filtered by `env.callerOverrides` against the policy resolved without
 *   the caller. A caller `userAgent` without a `userAgentMode` implies `strict`
 *   (their UA is what goes out).
 *
 * `provenance` names the layer that set each field. Spec 1690 — lane B1.
 */
export function resolveCrawlPolicy(input: CrawlPolicyResolveInput, env?: CrawlPolicyEnvConfig): ResolvedCrawlPolicy {
  return explainCrawlPolicy(input, env).policy;
}

/** `resolveCrawlPolicy` with the metadata of how the result came about. */
export function explainCrawlPolicy(input: CrawlPolicyResolveInput, env?: CrawlPolicyEnvConfig): CrawlPolicyExplanation {
  const cfg: CrawlPolicyEnvConfig = env ?? readCrawlPolicyEnv();
  const contact = (cfg as Partial<ParsedCrawlPolicyEnv>).contact;
  const notes: string[] = [];

  // A hand-built config may omit these (→ the documented defaults) or carry a bad
  // value (→ polite / fail-safe "stricter", with a note).
  const preset: CrawlPreset =
    cfg.preset === undefined ? 'polite' : hasOwn(CRAWL_PRESETS, cfg.preset) ? cfg.preset : 'polite';
  if (cfg.preset !== undefined && preset !== cfg.preset) {
    notes.push(`unknown preset ${JSON.stringify(cfg.preset)}; using "polite"`);
  }
  const callerOverrides = effectiveCallerOverridePolicy(cfg.callerOverrides);
  if (cfg.callerOverrides !== undefined && callerOverrides !== cfg.callerOverrides) {
    notes.push(`unknown callerOverrides ${JSON.stringify(cfg.callerOverrides)}; using "stricter"`);
  }

  const policy: CrawlPolicy = clonePolicy(CRAWL_PRESETS[preset]);
  // Built in one go: an object grown by ~24 keyed stores drops to V8 dictionary
  // mode, which made every copy of the resolved policy (per request) ~50x slower.
  const provenance: ResolvedCrawlPolicy['provenance'] = Object.fromEntries(
    CRAWL_POLICY_FIELDS.filter((field) => policy[field] !== undefined).map((field) => [field, 'preset']),
  );

  // Layers are validated once per layer object (env, file, manifest and caller
  // objects are shared and never mutated), not once per request.
  const prepare = (raw: unknown, label: string): CrawlPolicyOverride => {
    const { value, warnings } = normalizedLayer(raw, contact);
    for (const w of warnings) notes.push(`${label}: ${w}`);
    return value;
  };

  // 2. env-global
  applyLayer(policy, provenance, prepare(cfg.global, 'env-global'), 'env-global');

  // 3. builtin-host (EVER_JOBS_CRAWL_BUILTIN_HOSTS; off under `legacy`, which had none).
  const host = normalizeHostName(input.host);
  let builtinHost: string | undefined;
  if (host !== undefined && hasOwn(BUILTIN_HOST_POLICIES, host)) {
    if (crawlBuiltinHostsEnabled(cfg)) {
      builtinHost = host;
      applyLayer(policy, provenance, prepare(BUILTIN_HOST_POLICIES[host], 'builtin-host'), 'builtin-host');
    } else {
      notes.push(`builtin host policy for ${host} not applied (${CRAWL_EXTRA_ENV.BUILTIN_HOSTS}=false)`);
    }
  }

  // 4. plugin: manifest (EVER_JOBS_CRAWL_PLUGIN_MANIFESTS; off under `legacy`),
  //    then explicit createHttpClient options (explicit wins).
  const manifestEnabled = crawlPluginManifestsEnabled(cfg);
  if (!manifestEnabled && input.plugin && Object.keys(input.plugin).length > 0) {
    notes.push(`plugin manifest crawl policy not applied (${CRAWL_EXTRA_ENV.PLUGIN_MANIFESTS}=false)`);
  }
  const pluginLayer: CrawlPolicyOverride = {
    ...(manifestEnabled ? prepare(input.plugin, 'plugin manifest') : {}),
    ...prepare(input.explicit, 'plugin options'),
  };
  // A plugin's `userAgent` is a DECLARED UA (Spec 1690 §4.2), never the configured
  // one: it goes on the wire only when the resolved mode lets the plugin choose
  // (`plugin`, or `identify` with the plugin's opt-in) — see `HttpClient`.
  if (pluginLayer.userAgent !== undefined) {
    notes.push(
      `plugin declares userAgent ${JSON.stringify(pluginLayer.userAgent)}; it is sent only when ` +
        'userAgentMode resolves to "plugin" (or "identify" with the plugin\'s opt-in)',
    );
    delete pluginLayer.userAgent;
  }
  if (
    pluginLayer.userAgentMode !== undefined &&
    pluginLayer.userAgentMode !== 'strict' &&
    policy.userAgentMode === 'strict'
  ) {
    notes.push(
      `plugin asked for userAgentMode "${pluginLayer.userAgentMode}" but ${provenance.userAgentMode ?? 'preset'} ` +
        'pins "strict"; ignored',
    );
    delete pluginLayer.userAgentMode;
  }
  let userAgentReason: string | undefined;
  if (pluginLayer.userAgentMode === 'plugin') {
    const reason =
      (manifestEnabled ? input.plugin?.userAgentReason : undefined) ??
      (input.explicit as PluginCrawlPolicy | undefined)?.userAgentReason;
    if (typeof reason === 'string' && reason.trim()) userAgentReason = reason.trim();
    else notes.push('plugin opts into userAgentMode "plugin" without a userAgentReason');
  }
  applyLayer(policy, provenance, pluginLayer, 'plugin');

  // 5a. operator-site
  const policies = cfg.policies ?? {};
  let operatorSite: string | undefined;
  if (input.site !== undefined && policies.sites) {
    operatorSite = findSiteKey(policies.sites, input.site);
    if (operatorSite !== undefined) {
      applyLayer(policy, provenance, prepare(policies.sites[operatorSite], `operator site "${operatorSite}"`), 'operator-site');
    }
  }

  // 5b. operator-host: every matching pattern, least specific first.
  const operatorHostPatterns: string[] = [];
  if (host !== undefined && policies.hosts) {
    const matches = Object.keys(policies.hosts)
      .filter((pattern) => matchHostPattern(pattern, host))
      .map((pattern, index) => ({ pattern, index, specificity: hostPatternSpecificity(pattern) }))
      .sort((a, b) => a.specificity - b.specificity || a.index - b.index);
    for (const { pattern } of matches) {
      operatorHostPatterns.push(pattern);
      applyLayer(policy, provenance, prepare(policies.hosts[pattern], `operator host "${pattern}"`), 'operator-host');
    }
  }

  // 6. caller, filtered against the policy resolved without it.
  const callerRaw = prepare(input.caller, 'caller');
  const { accepted, rejected } = filterCallerOverride(callerRaw, policy, callerOverrides);
  if (accepted.userAgent !== undefined && callerRaw.userAgentMode === undefined && accepted.userAgentMode === undefined) {
    accepted.userAgentMode = 'strict';
  }
  applyLayer(policy, provenance, accepted, 'caller');

  // `legacy`: before Spec 1690 one ceiling (`retryMaxDelay`) bounded both the
  // backoff and an honoured Retry-After, so unless a layer set `maxRetryAfterMs`
  // itself it follows `retryMaxDelayMs` (RETRY_PER_SOURCE, a caller's
  // retryMaxDelay…) — the `cap` arithmetic then equals the pre-1690 one.
  if (
    preset === 'legacy' &&
    provenance.maxRetryAfterMs === 'preset' &&
    provenance.retryMaxDelayMs !== 'preset' &&
    policy.maxRetryAfterMs !== policy.retryMaxDelayMs
  ) {
    policy.maxRetryAfterMs = policy.retryMaxDelayMs;
    provenance.maxRetryAfterMs = provenance.retryMaxDelayMs;
    notes.push(`legacy preset: maxRetryAfterMs follows retryMaxDelayMs (${policy.retryMaxDelayMs}ms), as before Spec 1690`);
  }

  if (policy.userAgentMode !== 'plugin' || provenance.userAgentMode !== 'plugin') userAgentReason = undefined;

  const explanation: CrawlPolicyExplanation = {
    policy: { ...policy, provenance },
    preset,
    callerOverrides,
    callerRejected: rejected,
    operatorHostPatterns,
    notes,
  };
  if (userAgentReason !== undefined) explanation.userAgentReason = userAgentReason;
  if (builtinHost !== undefined) explanation.builtinHost = builtinHost;
  if (operatorSite !== undefined) explanation.operatorSite = operatorSite;
  return explanation;
}

/**
 * Apply `EVER_JOBS_CRAWL_CALLER_OVERRIDES` to what a search caller asked for:
 * `any` accepts everything, `none` nothing, `stricter` only values at least as
 * polite as `base` (per-field comparators).
 *
 * `stricter` comparators — a value is accepted when it is **at least as polite**
 * as `base` (equal is always accepted):
 *
 * | Field                  | Accepted when                                                      |
 * |------------------------|--------------------------------------------------------------------|
 * | userAgent, from        | unchanged — an identity change is never "stricter"                 |
 * | userAgentMode          | strict > identify > plugin                                         |
 * | stripClientHints       | true                                                               |
 * | proxyRotation          | off = per-host > per-scrape > per-request                          |
 * | rateLimitScope         | domain = site > host                                               |
 * | maxConcurrentPerHost   | lower; 0 means unlimited (least strict)                            |
 * | minIntervalMs, jitterMs, retryBaseDelayMs, retryMaxDelayMs | higher                         |
 * | maxQueueWaitMs         | any — pacing is enforced either way (not a politeness knob)        |
 * | adaptiveThrottle       | true                                                               |
 * | retries                | lower                                                              |
 * | retryStatuses          | a subset of base                                                   |
 * | retryBackoff           | exponential > linear > constant                                    |
 * | retryJitter            | true                                                               |
 * | retryOnNetworkError    | false                                                              |
 * | respectRetryAfter      | true                                                               |
 * | retryAfterOverMax      | give-up > cap                                                      |
 * | maxRetryAfterMs        | any under `give-up` (we never retry early); higher under `cap`     |
 * | robotsTxt              | respect > crawl-delay > off                                        |
 * | blockPrivateNetworks   | true                                                               |
 * | discovery              | any — not a politeness knob                                        |
 *
 * `blockPrivateNetworks` is a security boundary (SSRF guard), not a politeness
 * knob: a caller may turn it ON in every mode but may never turn it OFF — not
 * even under `any`. Operators disable it with env / operator policy.
 *
 * Fields that are not `CrawlPolicy` fields are rejected. A missing `mode` means
 * `any` (the documented default); an unknown one is treated as `stricter` (fail
 * safe).
 */
export function filterCallerOverride(
  caller: CrawlPolicyOverride | undefined,
  base: CrawlPolicy,
  mode: CallerOverridePolicy,
): { accepted: CrawlPolicyOverride; rejected: string[] } {
  const accepted: CrawlPolicyOverride = {};
  const acceptedRecord = accepted as Record<string, unknown>;
  const rejected: string[] = [];
  if (!caller) return { accepted, rejected };

  const effectiveMode = effectiveCallerOverridePolicy(mode);
  const callerRecord = caller as Record<string, unknown>;

  // `maxRetryAfterMs` is judged against the Retry-After mode that will be in force.
  let overMax = base.retryAfterOverMax;
  const callerOverMax = callerRecord.retryAfterOverMax;
  if (
    callerOverMax !== undefined &&
    (effectiveMode === 'any' ||
      (effectiveMode === 'stricter' && isAtLeastAsStrict('retryAfterOverMax', callerOverMax, base, overMax)))
  ) {
    overMax = callerOverMax as CrawlPolicy['retryAfterOverMax'];
  }

  for (const key of Object.keys(caller)) {
    const value = callerRecord[key];
    if (value === undefined) continue;
    if (!isCrawlPolicyField(key) || effectiveMode === 'none') {
      rejected.push(key);
      continue;
    }
    const ok =
      CRAWL_CALLER_SECURITY_FIELDS.includes(key) || effectiveMode === 'stricter'
        ? isAtLeastAsStrict(key, value, base, overMax)
        : true;
    if (ok) acceptedRecord[key] = Array.isArray(value) ? [...value] : value;
    else rejected.push(key);
  }
  return { accepted, rejected };
}

/**
 * Fields a caller may only tighten, whatever `EVER_JOBS_CRAWL_CALLER_OVERRIDES`
 * says (security boundaries, not politeness preferences).
 */
export const CRAWL_CALLER_SECURITY_FIELDS: readonly (keyof CrawlPolicy)[] = ['blockPrivateNetworks'];

/**
 * Validate an untrusted object (env JSON, file, API body) into an override.
 *
 * Unknown keys, wrong types and out-of-range values are dropped with a warning
 * (never thrown). `undefined`/`null` fields mean "not set". Coercions: numeric
 * strings for numbers (fractions floored, values above 2^31-1 clamped),
 * `true/false/1/0/yes/no/on/off` for booleans, case-insensitive enums (`_`
 * accepted for `-`), `"429,503"` or `[429, 503]` for status lists (`"none"` =
 * `[]`), and header-unsafe characters stripped from `userAgent`/`from`. Keys
 * starting with `$`, `_` or `//` (JSON "comments") and `userAgentReason` are
 * skipped silently. UA keywords are NOT expanded here (the resolver does it).
 */
export function normalizeCrawlOverride(raw: unknown): { value: CrawlPolicyOverride; warnings: string[] } {
  return normalizeOverride(raw);
}

/**
 * `pattern` is an exact host or `*.suffix` (matches any subdomain, not the apex).
 * Also accepts `*` (every host). Case-insensitive; a trailing dot and a `:port`
 * on either side are ignored.
 */
export function matchHostPattern(pattern: string, host: string): boolean {
  return hostMatches(pattern, host);
}

// ── internals ────────────────────────────────────────────────────────────────

/** Missing → `any` (the default); unknown → `stricter` (fail safe). */
function effectiveCallerOverridePolicy(mode: CallerOverridePolicy | undefined): CallerOverridePolicy {
  if (mode === undefined) return 'any';
  return CALLER_OVERRIDE_POLICIES.includes(mode) ? mode : 'stricter';
}

const USER_AGENT_MODE_RANK: Record<string, number> = { plugin: 1, identify: 2, strict: 3 };
const PROXY_ROTATION_RANK: Record<string, number> = { 'per-request': 1, 'per-scrape': 2, 'per-host': 3, off: 3 };
const RATE_SCOPE_RANK: Record<string, number> = { host: 1, domain: 2, site: 2 };
const RETRY_BACKOFF_RANK: Record<string, number> = { constant: 1, linear: 2, exponential: 3 };
const OVER_MAX_RANK: Record<string, number> = { cap: 1, 'give-up': 2 };
const ROBOTS_RANK: Record<string, number> = { off: 1, 'crawl-delay': 2, respect: 3 };

function rankAtLeast(ranks: Record<string, number>, candidate: unknown, base: unknown): boolean {
  const c = typeof candidate === 'string' && hasOwn(ranks, candidate) ? ranks[candidate] : undefined;
  const b = typeof base === 'string' && hasOwn(ranks, base) ? ranks[base] : undefined;
  if (c === undefined) return false;
  return b === undefined || c >= b;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** Whether `candidate` for `field` is at least as polite as `base[field]`. */
function isAtLeastAsStrict(
  field: keyof CrawlPolicy,
  candidate: unknown,
  base: CrawlPolicy,
  overMax: CrawlPolicy['retryAfterOverMax'],
): boolean {
  const current: unknown = base[field];
  if (candidate === current) return true;
  switch (field) {
    case 'userAgent':
    case 'from':
      return false;
    case 'userAgentMode':
      return rankAtLeast(USER_AGENT_MODE_RANK, candidate, current);
    case 'proxyRotation':
      return rankAtLeast(PROXY_ROTATION_RANK, candidate, current);
    case 'rateLimitScope':
      return rankAtLeast(RATE_SCOPE_RANK, candidate, current);
    case 'retryBackoff':
      return rankAtLeast(RETRY_BACKOFF_RANK, candidate, current);
    case 'retryAfterOverMax':
      return rankAtLeast(OVER_MAX_RANK, candidate, current);
    case 'robotsTxt':
      return rankAtLeast(ROBOTS_RANK, candidate, current);
    case 'maxConcurrentPerHost': {
      const limit = (v: unknown) => (num(v) === 0 ? Infinity : num(v));
      return limit(candidate) <= limit(current);
    }
    case 'minIntervalMs':
    case 'jitterMs':
    case 'retryBaseDelayMs':
    case 'retryMaxDelayMs':
      return num(candidate) >= num(current);
    case 'retries':
      return num(candidate) <= num(current);
    case 'maxRetryAfterMs':
      return overMax === 'give-up' || num(candidate) >= num(current);
    case 'retryStatuses':
      return (
        Array.isArray(candidate) &&
        Array.isArray(current) &&
        candidate.every((status) => (current as unknown[]).includes(status))
      );
    case 'stripClientHints':
    case 'adaptiveThrottle':
    case 'retryJitter':
    case 'respectRetryAfter':
    case 'blockPrivateNetworks':
      return candidate === true;
    case 'retryOnNetworkError':
      return candidate === false;
    case 'maxQueueWaitMs':
    case 'discovery':
      return true;
  }
}

interface NormalizedLayer {
  value: CrawlPolicyOverride;
  warnings: string[];
  contact: string | undefined;
}

/** Validated layers by the identity of the raw layer object (see `normalizedLayer`). */
let normalizedLayers = new WeakMap<object, NormalizedLayer>();
const EMPTY_LAYER: NormalizedLayer = Object.freeze({ value: Object.freeze({}), warnings: [], contact: undefined });

/**
 * `normalizeCrawlOverride(raw)` with any `userAgent` expanded (keywords + the
 * operator contact), memoised per raw object: the env-global, builtin-host,
 * operator and plugin-manifest layers are long-lived shared objects and the
 * caller's override is one object per search, so a policy-cache miss (one per
 * site × host) no longer re-validates every layer. The result is shared — callers
 * copy what they change (`applyLayer` copies each value).
 */
function normalizedLayer(raw: unknown, contact: string | undefined): NormalizedLayer {
  if (raw === undefined || raw === null) return EMPTY_LAYER;
  const key = typeof raw === 'object' ? (raw as object) : undefined;
  const hit = key ? normalizedLayers.get(key) : undefined;
  if (hit && hit.contact === contact) return hit;
  const { value, warnings } = normalizeCrawlOverride(raw);
  if (value.userAgent !== undefined) value.userAgent = expandUserAgent(value.userAgent, contact);
  const layer: NormalizedLayer = { value, warnings, contact };
  if (key) normalizedLayers.set(key, layer);
  return layer;
}

/**
 * Forget memoised layer validations. Only needed when a layer object is mutated in
 * place after it was resolved (tests); a new env parse or new object is a new key.
 */
export function resetCrawlPolicyLayerCache(): void {
  normalizedLayers = new WeakMap();
}

function clonePolicy(policy: CrawlPolicy): CrawlPolicy {
  return { ...policy, retryStatuses: [...policy.retryStatuses] };
}

function applyLayer(
  policy: CrawlPolicy,
  provenance: ResolvedCrawlPolicy['provenance'],
  layer: CrawlPolicyOverride,
  name: CrawlPolicyLayer,
): void {
  const target = policy as unknown as Record<string, unknown>;
  for (const field of CRAWL_POLICY_FIELDS) {
    const value = layer[field];
    if (value === undefined) continue;
    target[field] = Array.isArray(value) ? [...value] : value;
    provenance[field] = name;
  }
}

/** Exact key first, then a case-insensitive match (hand-built configs may not be lower-cased). */
function findSiteKey(sites: Record<string, CrawlPolicyOverride>, site: string): string | undefined {
  if (hasOwn(sites, site)) return site;
  const wanted = site.trim().toLowerCase();
  if (!wanted) return undefined;
  return Object.keys(sites).find((key) => key.trim().toLowerCase() === wanted);
}
