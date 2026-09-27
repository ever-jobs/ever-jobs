import { CALLER_OVERRIDES_RANK } from './caller-lock';
import { BUILTIN_HOST_POLICIES, CRAWL_ENV, CRAWL_PRESETS } from './defaults';
import {
  CRAWL_EXTRA_ENV,
  CrawlStricterRules,
  ParsedCrawlPolicyEnv,
  crawlBuiltinHostsDisabled,
  crawlBuiltinHostsEnabled,
  crawlPluginManifestsEnabled,
  crawlStricterRules,
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
  CallerOverridesResolution,
  CallerOverridesSource,
  CrawlPolicy,
  CrawlPolicyEnvConfig,
  CrawlPolicyLayer,
  CrawlPolicyOverride,
  CrawlPolicyResolveInput,
  CrawlPreset,
  PluginCrawlPolicy,
  RateLimitScope,
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
  /**
   * The EFFECTIVE caller-override mode the caller layer was filtered with (Spec
   * 1714): the global `EVER_JOBS_CRAWL_CALLER_OVERRIDES` tightened by a site
   * owner's lock, or an operator's per-site / per-host value. Equal to the global
   * mode for every source without a lock.
   */
  callerOverrides: CallerOverridePolicy;
  /** The layer that decided `callerOverrides` (Spec 1714 FR-3). */
  callerOverridesSource: CallerOverridesSource;
  /** `EVER_JOBS_CRAWL_CALLER_OVERRIDES` (or its default `any`). */
  globalCallerOverrides: CallerOverridePolicy;
  /** The plugin's `userAgentReason`, when its `userAgentMode: 'plugin'` opt-in is in effect. */
  userAgentReason?: string;
  /** Caller fields refused by the effective caller-override mode (or not policy fields, e.g. `callerOverrides`). */
  callerRejected: string[];
  /** Builtin host policy applied (the normalised host), if any pattern matched. */
  builtinHost?: string;
  /** Builtin host patterns applied (`BUILTIN_HOST_POLICIES` keys), least specific first (Spec 1714). */
  builtinHostPatterns: string[];
  /**
   * Builtin host patterns that match the host but were NOT applied because
   * `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` lists them (Spec 1715 audit F3), least
   * specific first. The whole-layer switch `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`
   * is reported in `notes` instead.
   */
  builtinHostPatternsDisabled: string[];
  /** `rateLimitScope` as resolved BEFORE the caller layer — the `per-host` proxy pin keys on it (Spec 1714 FR-6). */
  baseRateLimitScope: RateLimitScope;
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
 * - builtin-host: every `BUILTIN_HOST_POLICIES` pattern matching the host (an
 *   exact host or `*.suffix`, the operator `hosts` semantics), least specific
 *   first, unless `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (the `legacy` preset's
 *   default) — Spec 1714 FR-8 — or `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` lists
 *   that pattern (Spec 1715 audit F3; `builtinHostPatternsDisabled`).
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
 * - caller: filtered against the policy resolved without the caller, with the
 *   EFFECTIVE caller-override mode (Spec 1714 FR-2, `resolveCallerOverrides`):
 *   the most restrictive of `env.callerOverrides`, the plugin layer's
 *   `callerOverrides` and every applied builtin host pattern's — replaced
 *   outright by an operator `sites` / `hosts` value when one is set — using the
 *   `EVER_JOBS_CRAWL_STRICTER_RULES` comparators. A caller `userAgent` without a
 *   `userAgentMode` implies `strict` (their UA is what goes out).
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
  const globalCallerOverrides = effectiveCallerOverridePolicy(cfg.callerOverrides);
  if (cfg.callerOverrides !== undefined && globalCallerOverrides !== cfg.callerOverrides) {
    notes.push(`unknown callerOverrides ${JSON.stringify(cfg.callerOverrides)}; using "stricter"`);
  }
  // Spec 1714: the caller-override locks met while walking the layers.
  const locks: CallerOverrideLocks = { builtin: [], plugin: [], operatorHosts: [] };

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

  // 3. builtin-host (EVER_JOBS_CRAWL_BUILTIN_HOSTS; off under `legacy`, which had
  //    none): every matching pattern, least specific first (Spec 1714 FR-8),
  //    except those EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE lists (Spec 1715 F3).
  const host = normalizeHostName(input.host);
  let builtinHost: string | undefined;
  const builtinHostPatterns: string[] = [];
  const builtinHostPatternsDisabled: string[] = [];
  const builtinMatches = host !== undefined ? matchingHostPatterns(Object.keys(BUILTIN_HOST_POLICIES), host) : [];
  if (host !== undefined && builtinMatches.length > 0) {
    if (crawlBuiltinHostsEnabled(cfg)) {
      const disabled = crawlBuiltinHostsDisabled(cfg);
      for (const pattern of builtinMatches) {
        if (disabled.includes(pattern)) {
          builtinHostPatternsDisabled.push(pattern);
          notes.push(
            `builtin host policy "${pattern}" for ${host} not applied (${CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE} lists it)`,
          );
          continue;
        }
        builtinHost = host;
        builtinHostPatterns.push(pattern);
        const layer = prepare(BUILTIN_HOST_POLICIES[pattern], 'builtin-host');
        applyLayer(policy, provenance, layer, 'builtin-host');
        locks.builtin.push(layer.callerOverrides);
      }
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
  const manifestLayer = manifestEnabled ? prepare(input.plugin, 'plugin manifest') : {};
  const explicitLayer = prepare(input.explicit, 'plugin options');
  // The manifest's lock, then the client options' — each can only tighten (Spec 1714 FR-2).
  locks.plugin.push(manifestLayer.callerOverrides, explicitLayer.callerOverrides);
  const pluginLayer: CrawlPolicyOverride = { ...manifestLayer, ...explicitLayer };
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
      const layer = prepare(policies.sites[operatorSite], `operator site "${operatorSite}"`);
      applyLayer(policy, provenance, layer, 'operator-site');
      locks.operatorSite = layer.callerOverrides;
    }
  }

  // 5b. operator-host: every matching pattern, least specific first.
  const operatorHostPatterns: string[] = [];
  if (host !== undefined && policies.hosts) {
    for (const pattern of matchingHostPatterns(Object.keys(policies.hosts), host)) {
      operatorHostPatterns.push(pattern);
      const layer = prepare(policies.hosts[pattern], `operator host "${pattern}"`);
      applyLayer(policy, provenance, layer, 'operator-host');
      locks.operatorHosts.push(layer.callerOverrides);
    }
  }

  // 6. caller, filtered against the policy resolved without it, with the
  //    effective caller-override mode (Spec 1714 FR-2) and comparators (FR-4).
  const lock = foldCallerOverrides(globalCallerOverrides, globalCallerOverridesSource(cfg), locks);
  if (lock.mode !== globalCallerOverrides) {
    notes.push(
      `caller overrides "${lock.mode}" (set by ${lock.source}) instead of the global ` +
        `${CRAWL_ENV.CALLER_OVERRIDES}="${globalCallerOverrides}"`,
    );
  }
  const baseRateLimitScope = policy.rateLimitScope;
  const callerRaw = prepare(input.caller, 'caller');
  const { accepted, rejected } = filterCallerOverride(callerRaw, policy, lock.mode, { rules: crawlStricterRules(cfg) });
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
    callerOverrides: lock.mode,
    callerOverridesSource: lock.source,
    globalCallerOverrides,
    callerRejected: rejected,
    builtinHostPatterns,
    builtinHostPatternsDisabled,
    baseRateLimitScope,
    operatorHostPatterns,
    notes,
  };
  if (userAgentReason !== undefined) explanation.userAgentReason = userAgentReason;
  if (builtinHost !== undefined) explanation.builtinHost = builtinHost;
  if (operatorSite !== undefined) explanation.operatorSite = operatorSite;
  return explanation;
}

/**
 * The effective caller-override mode for one request (Spec 1714 FR-2) — the
 * same computation `explainCrawlPolicy` makes, without building a policy (what
 * `JobsService` needs per source, where no host is known yet):
 *
 * 1. start at the global `EVER_JOBS_CRAWL_CALLER_OVERRIDES` (source `default`
 *    when unset, else `env-global`);
 * 2. fold in every applied builtin host pattern's `callerOverrides` (least
 *    specific first), then the plugin layer's (the manifest when
 *    `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS` is on, then the plugin's client
 *    options), each taken when it is at least as restrictive as the current mode
 *    (`none` > `stricter` > `any`; on a tie the higher layer becomes the source);
 * 3. an operator `sites[<site>].callerOverrides`, then every matching operator
 *    `hosts` pattern's (least specific first), REPLACES the mode outright —
 *    looser or tighter (the operator decides; the most specific setting wins).
 */
export function resolveCallerOverrides(
  input: CrawlPolicyResolveInput,
  env?: CrawlPolicyEnvConfig,
): CallerOverridesResolution {
  const cfg: CrawlPolicyEnvConfig = env ?? readCrawlPolicyEnv();
  const contact = (cfg as Partial<ParsedCrawlPolicyEnv>).contact;
  const lockOf = (raw: unknown): CallerOverridePolicy | undefined => normalizedLayer(raw, contact).value.callerOverrides;
  const host = normalizeHostName(input.host);
  const locks: CallerOverrideLocks = { builtin: [], plugin: [], operatorHosts: [] };

  if (host !== undefined && crawlBuiltinHostsEnabled(cfg)) {
    const disabled = crawlBuiltinHostsDisabled(cfg);
    for (const pattern of matchingHostPatterns(Object.keys(BUILTIN_HOST_POLICIES), host)) {
      if (!disabled.includes(pattern)) locks.builtin.push(lockOf(BUILTIN_HOST_POLICIES[pattern]));
    }
  }
  locks.plugin.push(crawlPluginManifestsEnabled(cfg) ? lockOf(input.plugin) : undefined, lockOf(input.explicit));

  const policies = cfg.policies ?? {};
  if (input.site !== undefined && policies.sites) {
    const siteKey = findSiteKey(policies.sites, input.site);
    if (siteKey !== undefined) locks.operatorSite = lockOf(policies.sites[siteKey]);
  }
  if (host !== undefined && policies.hosts) {
    for (const pattern of matchingHostPatterns(Object.keys(policies.hosts), host)) {
      locks.operatorHosts.push(lockOf(policies.hosts[pattern]));
    }
  }
  return foldCallerOverrides(effectiveCallerOverridePolicy(cfg.callerOverrides), globalCallerOverridesSource(cfg), locks);
}

/**
 * Whether requests to `host` fall under a HOST-level policy that must pace them on
 * their own (Spec 1715, audit A0): a builtin host pattern that applies (the layer
 * is on — `EVER_JOBS_CRAWL_BUILTIN_HOSTS` — and `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE`
 * does not list it) or an operator `hosts` pattern, matching `host`, whose entry
 * sets a caller lock (`callerOverrides` `stricter` or `none`) or
 * `rateLimitScope: 'domain'` — e.g. `*.softy.pro`. `HttpClient` re-issues a redirect
 * hop to such a host as a request of its own even when it stays in the same
 * rate-limit bucket (`EVER_JOBS_CRAWL_PACE_REDIRECTS`). `host` may be a hostname or
 * a URL; false for an unparseable one.
 */
export function isPolicyOwnedHost(host: string | undefined, env?: CrawlPolicyEnvConfig): boolean {
  const cfg: CrawlPolicyEnvConfig = env ?? readCrawlPolicyEnv();
  const name = normalizeHostName(host);
  if (name === undefined) return false;
  const contact = (cfg as Partial<ParsedCrawlPolicyEnv>).contact;
  const owns = (raw: unknown): boolean => {
    const layer = normalizedLayer(raw, contact).value;
    return layer.callerOverrides === 'stricter' || layer.callerOverrides === 'none' || layer.rateLimitScope === 'domain';
  };
  if (crawlBuiltinHostsEnabled(cfg)) {
    const disabled = crawlBuiltinHostsDisabled(cfg);
    for (const pattern of matchingHostPatterns(Object.keys(BUILTIN_HOST_POLICIES), name)) {
      if (!disabled.includes(pattern) && owns(BUILTIN_HOST_POLICIES[pattern])) return true;
    }
  }
  const hosts = cfg.policies?.hosts;
  if (hosts) {
    for (const pattern of matchingHostPatterns(Object.keys(hosts), name)) {
      if (owns(hosts[pattern])) return true;
    }
  }
  return false;
}

/**
 * Apply a caller-override mode to what a search caller asked for: `any` accepts
 * everything, `none` nothing, `stricter` only values at least as polite as `base`
 * (per-field comparators). The mode is the EFFECTIVE one of the request
 * (`resolveCallerOverrides`, Spec 1714), not only the global
 * `EVER_JOBS_CRAWL_CALLER_OVERRIDES`.
 *
 * `stricter` comparators — a value is accepted when it is **at least as polite**
 * as `base` (equal is always accepted). `options.rules` picks the column
 * (`EVER_JOBS_CRAWL_STRICTER_RULES`; default `1714`, `1690` = pre-1714):
 *
 * | Field                  | Rules `1714` (default)                                  | Rules `1690`                        |
 * |------------------------|---------------------------------------------------------|-------------------------------------|
 * | userAgent, from        | never — an identity change is never "stricter"          | same                                |
 * | userAgentMode          | strict > identify > plugin                              | same                                |
 * | stripClientHints       | true                                                    | same                                |
 * | proxyRotation          | off < per-host < per-scrape < per-request; accept ≤ base | off = per-host > per-scrape > per-request |
 * | rateLimitScope         | equal, or `host` → `domain` (no parallel bucket)        | domain = site > host                |
 * | maxConcurrentPerHost   | lower; 0 means unlimited (refused unless base is 0)     | same                                |
 * | minIntervalMs, jitterMs, retryBaseDelayMs, retryMaxDelayMs, minGapMs, serverErrorCooldownMs | higher | same |
 * | throttleRetryDelayMs   | higher (0 = no floor = least strict)                    | same                                |
 * | maxQueueWaitMs         | any — pacing is enforced either way                     | same                                |
 * | adaptiveThrottle       | true                                                    | same                                |
 * | retries                | lower                                                   | same                                |
 * | retryStatuses          | keeps every 429/503 of base; may drop others; may add only 429/503 | a subset of base          |
 * | retryBackoff           | exponential > linear > constant                         | same                                |
 * | retryJitter            | true                                                    | same                                |
 * | retryOnNetworkError    | false                                                   | same                                |
 * | respectRetryAfter      | true                                                    | same                                |
 * | retryAfterOverMax      | give-up > cap                                           | same                                |
 * | maxRetryAfterMs        | any under `give-up` (we never retry early); higher under `cap` | same                      |
 * | robotsTxt              | respect > crawl-delay > off                             | same                                |
 * | blockPrivateNetworks   | true                                                    | same                                |
 * | discovery              | equal, or `sitemap`                                     | any                                 |
 *
 * `blockPrivateNetworks` is a security boundary (SSRF guard), not a politeness
 * knob: a caller may turn it ON in every mode but may never turn it OFF — not
 * even under `any`. Operators disable it with env / operator policy.
 *
 * Fields that are not `CrawlPolicy` fields — including the `callerOverrides`
 * lock itself — are rejected. A missing `mode` means `any` (the documented
 * default); an unknown one is treated as `stricter` (fail safe).
 */
export function filterCallerOverride(
  caller: CrawlPolicyOverride | undefined,
  base: CrawlPolicy,
  mode: CallerOverridePolicy,
  options: { rules?: CrawlStricterRules } = {},
): { accepted: CrawlPolicyOverride; rejected: string[] } {
  const accepted: CrawlPolicyOverride = {};
  const acceptedRecord = accepted as Record<string, unknown>;
  const rejected: string[] = [];
  if (!caller) return { accepted, rejected };

  const effectiveMode = effectiveCallerOverridePolicy(mode);
  const rules: CrawlStricterRules = options.rules === '1690' ? '1690' : '1714';
  const callerRecord = caller as Record<string, unknown>;

  // `maxRetryAfterMs` is judged against the Retry-After mode that will be in force.
  let overMax = base.retryAfterOverMax;
  const callerOverMax = callerRecord.retryAfterOverMax;
  if (
    callerOverMax !== undefined &&
    (effectiveMode === 'any' ||
      (effectiveMode === 'stricter' && isAtLeastAsStrict('retryAfterOverMax', callerOverMax, base, overMax, rules)))
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
        ? isAtLeastAsStrict(key, value, base, overMax, rules)
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

/** Source of the global mode: `env-global` when the operator set it, else `default`. */
function globalCallerOverridesSource(cfg: CrawlPolicyEnvConfig): CallerOverridesSource {
  const fromEnv = (cfg as Partial<ParsedCrawlPolicyEnv>).callerOverridesFromEnv;
  if (fromEnv === true) return 'env-global';
  return cfg.callerOverrides !== undefined && cfg.callerOverrides !== 'any' ? 'env-global' : 'default';
}

/** The `callerOverrides` locks met while walking the layers of one request (Spec 1714). */
interface CallerOverrideLocks {
  /** Applied builtin host patterns' locks, least specific first. */
  builtin: Array<CallerOverridePolicy | undefined>;
  /** The plugin manifest's lock, then the plugin's client options'. */
  plugin: Array<CallerOverridePolicy | undefined>;
  /** The operator `sites[<site>]` entry's lock. */
  operatorSite?: CallerOverridePolicy;
  /** Matching operator `hosts` patterns' locks, least specific first. */
  operatorHosts: Array<CallerOverridePolicy | undefined>;
}

/** Spec 1714 FR-2: see `resolveCallerOverrides`. */
function foldCallerOverrides(
  global: CallerOverridePolicy,
  globalSource: CallerOverridesSource,
  locks: CallerOverrideLocks,
): CallerOverridesResolution {
  let mode = global;
  let source = globalSource;
  const tighten = (candidate: CallerOverridePolicy | undefined, from: CallerOverridesSource): void => {
    if (candidate === undefined || !hasOwn(CALLER_OVERRIDES_RANK, candidate)) return;
    if (CALLER_OVERRIDES_RANK[candidate] >= CALLER_OVERRIDES_RANK[mode]) {
      mode = candidate;
      source = from;
    }
  };
  for (const candidate of locks.builtin) tighten(candidate, 'builtin-host');
  for (const candidate of locks.plugin) tighten(candidate, 'plugin');
  // An operator value replaces the mode outright: the operator can loosen a lock too.
  const replace = (candidate: CallerOverridePolicy | undefined, from: CallerOverridesSource): void => {
    if (candidate === undefined || !hasOwn(CALLER_OVERRIDES_RANK, candidate)) return;
    mode = candidate;
    source = from;
  };
  replace(locks.operatorSite, 'operator-site');
  for (const candidate of locks.operatorHosts) replace(candidate, 'operator-host');
  return { mode, source, global };
}

/** `patterns` matching `host`, least specific first (ties in the given order). */
function matchingHostPatterns(patterns: readonly string[], host: string): string[] {
  return patterns
    .filter((pattern) => matchHostPattern(pattern, host))
    .map((pattern, index) => ({ pattern, index, specificity: hostPatternSpecificity(pattern) }))
    .sort((a, b) => a.specificity - b.specificity || a.index - b.index)
    .map((match) => match.pattern);
}

const USER_AGENT_MODE_RANK: Record<string, number> = { plugin: 1, identify: 2, strict: 3 };
/** Rules `1690`: `off` and `per-host` equal. */
const PROXY_ROTATION_RANK_1690: Record<string, number> = { 'per-request': 1, 'per-scrape': 2, 'per-host': 3, off: 3 };
/** Rules `1714`: off < per-host < per-scrape < per-request (by how many origins a site sees). */
const PROXY_ROTATION_RANK_1714: Record<string, number> = { 'per-request': 1, 'per-scrape': 2, 'per-host': 3, off: 4 };
/** Rules `1690` only (rules `1714` accept equal, or `host` → `domain`). */
const RATE_SCOPE_RANK: Record<string, number> = { host: 1, domain: 2, site: 2 };
/** Statuses a caller may never drop from, and may always add to, `retryStatuses` (rules `1714`). */
const THROTTLE_RETRY_STATUSES: readonly number[] = [429, 503];
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

/**
 * Whether `candidate` for `field` is at least as polite as `base[field]` under
 * `rules` (see the table on `filterCallerOverride`).
 */
function isAtLeastAsStrict(
  field: keyof CrawlPolicy,
  candidate: unknown,
  base: CrawlPolicy,
  overMax: CrawlPolicy['retryAfterOverMax'],
  rules: CrawlStricterRules = '1714',
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
      return rankAtLeast(rules === '1690' ? PROXY_ROTATION_RANK_1690 : PROXY_ROTATION_RANK_1714, candidate, current);
    case 'rateLimitScope':
      // 1714: the caller's bucket must CONTAIN the base bucket — `host` → `domain`
      // only; `site` next to `domain` would be a second, parallel bucket (G5).
      if (rules === '1690') return rankAtLeast(RATE_SCOPE_RANK, candidate, current);
      return current === 'host' && candidate === 'domain';
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
    case 'throttleRetryDelayMs':
    case 'minGapMs':
    case 'serverErrorCooldownMs':
      return num(candidate) >= num(current);
    case 'retries':
      return num(candidate) <= num(current);
    case 'maxRetryAfterMs':
      return overMax === 'give-up' || num(candidate) >= num(current);
    case 'retryStatuses': {
      if (!Array.isArray(candidate) || !Array.isArray(current)) return false;
      const baseStatuses = current as unknown[];
      if (rules === '1690') return candidate.every((status) => baseStatuses.includes(status));
      // 1714: never drop the base's 429/503 handling; drop anything else; add only 429/503.
      return (
        THROTTLE_RETRY_STATUSES.every((status) => !baseStatuses.includes(status) || candidate.includes(status)) &&
        candidate.every((status) => baseStatuses.includes(status) || THROTTLE_RETRY_STATUSES.includes(status as number))
      );
    }
    case 'stripClientHints':
    case 'adaptiveThrottle':
    case 'retryJitter':
    case 'respectRetryAfter':
    case 'blockPrivateNetworks':
      return candidate === true;
    case 'retryOnNetworkError':
      return candidate === false;
    case 'maxQueueWaitMs':
      return true;
    case 'discovery':
      // 1714: towards the sitemap only (list pages cost a shared server more, G22).
      return rules === '1690' || candidate === 'sitemap';
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
