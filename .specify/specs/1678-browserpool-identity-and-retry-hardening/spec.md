# Spec: 1678 — Persistent-context identity, and hardening the Spec 5085 landings

| Field          | Value                                           |
| -------------- | ----------------------------------------------- |
| Spec ID        | 1678                                            |
| Slug           | browserpool-identity-and-retry-hardening        |
| Status         | done                                            |
| Owner          | agent                                           |
| Created        | 2026-08-16                                      |
| Last updated   | 2026-08-16                                      |
| Supersedes     | (none)                                          |
| Related specs  | 5076, 5081, 5085                                |

## 1. Problem Statement

Specs 5076 (`BrowserPool` headful / persistent-context opt-in) and 5085 (retry attribution +
`Retry-After`) landed via PR #53. A review of that PR before it was promoted to production found
defects in both that no test could catch, because the new `BrowserPool` tests mock every collaborator
and assert only that Playwright was called.

### 1.1 `BrowserPool` cached persistent contexts on the directory alone

`getPersistentContext(userDataDir, headful, ctxOpts)` keyed its cache on `userDataDir`. All three
headful callers (`source-ats-gusto-hosted`, `source-company-desktopmetal`,
`source-company-truemetalsupply`) omit `userDataDir`, so all three resolved to the **same** default
profile and therefore the **same cached context**. `ctxOpts` — which carries `proxy`, `userAgent` and
`viewport` — is only applied at launch, so the first caller's options were silently imposed on every
later one. A source configured to egress through a proxy would reuse a context launched without one
and go out direct. That is a correctness and egress-identity bug, not a cosmetic one.

The directory cannot simply be keyed more finely: Chromium locks a profile directory to a single
process, so two contexts with different options cannot share one directory either.

### 1.2 The stealth init script accumulated without bound

`getPage()` called `applyStealthToContext()` on every invocation. For an ephemeral context that is
correct — it is a fresh context each time. For a **reused persistent** context it re-registered
`STEALTH_INIT_SCRIPT` on each call, and Playwright replays every registered init script into every
new page. After N scrapes each new page ran N copies of the script.

### 1.3 Liveness detection was a tautology

```ts
return context.pages().length >= 0;   // true for every array
```

`BrowserContext` exposes no `isConnected()`, and `pages()` on a closed context returns `[]` without
throwing. So a crashed context stayed cached forever and poisoned every later headful call until the
pod restarted. The `persistentLaunching` guard was also never cleared on the success path.

### 1.4 The blank page was never closed

`launchPersistentContext` opens one page for you. Nothing closed it, so every persistent context
carried a permanent idle tab.

### 1.5 `headful` had no kill switch

`headful: true` hard-set `headless: false`. Headful needs a display server, which no deployed
environment has, and there was no configuration that could force callers back onto the headless path
without editing each plugin.

### 1.6 The correlation id was adopted verbatim

`requestContextMiddleware` trimmed the inbound `X-Request-Id` and used it as-is. That value is
reflected into the `X-Request-Id` response header and interpolated into every outbound retry log
line the request causes, with no length or charset bound.

### 1.7 A malformed `Retry-After` discarded the backoff

`retryAfterMs()` maps an unparseable or already-past value to `0` (`Math.max(0, date - Date.now())`),
and the caller preferred it over the computed backoff via `?? backoff` — which only falls back on
`null`, not on `0`. So `Retry-After: -30`, `Retry-After: not-a-date`, or any past HTTP-date turned a
429 into an immediate re-request, the opposite of the spec's stated intent.

## 2. Goals

- A persistent context is shared only by callers that agree on the options that context was launched
  with.
- Per-context setup happens once per context.
- A dead context is detected and replaced.
- `headful` can be disabled by configuration.
- An inbound correlation id cannot choose what lands in our logs or response headers.
- `Retry-After` can only ever push a retry later, never sooner.

## 3. Non-Goals

- **Making a browser work in production.** The runtime image ships no Chromium (see
  `workspace/knowledge/infrastructure/EVER_JOBS_DEPLOY_RUNTIME.md`), so every browser-driven source
  reports `browser_unavailable` regardless. Installing a browser, and the display server headful
  additionally needs, is an operator change with its own memory budget — out of scope here. This spec
  makes the pool correct *for when that happens*, and adds the switch to keep headful off until it does.
- Changing which plugins opt into headful.

## 4. Design

### 4.1 Launch identity

```ts
interface PersistentIdentity { headful: boolean; stealth: boolean; proxy?: string }
```

The cache key becomes `${userDataDir}|${headful}|${stealth}|${proxy ?? ''}`, and the profile
directory becomes `join(userDataDir, sha1(identity).slice(0, 8))`. `userDataDir` is therefore a
**profiles root** holding one profile per identity, rather than a single profile. This is what lets
two identities coexist without fighting over Chromium's directory lock, and it is deterministic —
the same identity resolves to the same directory across restarts, so the profile still persists.

UA and viewport are chosen once, when the context is created, and are stable for its lifetime. That
is also the more coherent behaviour: rotating the fingerprint of a profile whose cookies persist
makes it *more* detectable, not less.

### 4.2 Liveness by subscription, not inspection

`context.on('close', …)` marks the context in a `WeakSet` and evicts it from the cache, so the next
request relaunches. `persistentLaunching` is cleared in a `.finally()` on both paths.

### 4.3 Once-per-context work

`stealthApplied: WeakSet<BrowserContext>` gates `addInitScript`. `initialPages:
WeakMap<BrowserContext, Page[]>` holds the blank page until the caller's first real page exists,
then closes it — closing every page of a persistent context can take the context down with it, so
the order matters.

### 4.4 `EVER_JOBS_BROWSER_HEADFUL`

Unset or anything other than `false` → `headful` is honored (current behaviour). `false` → a headful
request is downgraded to headless with one `warn`, still persistent if a `userDataDir` was asked for.

### 4.5 Correlation id validation

`^[A-Za-z0-9._:-]+$`, at most 128 characters — enough for a UUID (36), a W3C `traceparent` (55) and
the usual vendor formats. Anything else is replaced with a minted UUID rather than sanitised.

### 4.6 `Retry-After` as a floor

```ts
const delay = Math.min(retryMaxDelay, Math.max(backoff, retryAfterMs ?? 0));
```

Retry-After may only push the retry later. A server asking for *less* than our backoff does not get
to talk us into hammering it, and a malformed value degrades to the backoff instead of to zero.

## 5. Acceptance

- Two `getPage()` calls with different proxies produce two contexts with two profile directories,
  each receiving its own proxy.
- Three `getPage()` calls against one persistent context register the init script once.
- A context that emits `close` is relaunched on the next call.
- A failed launch is retryable.
- `EVER_JOBS_BROWSER_HEADFUL=false` routes a headful request to the headless path.
- Malformed / negative / past `Retry-After` values keep the computed backoff.
- Overlong or malformed inbound `X-Request-Id` values are replaced.

## 6. Risks

- **Profile layout changes** from `<root>` to `<root>/<hash>`. Existing profiles are abandoned, not
  migrated. They are caches, headful has never run in a deployed environment, and the alternative
  (silently dropping a caller's proxy) is worse.
- `Retry-After` can no longer shorten a wait below the backoff. Intentional; it can only delay.
