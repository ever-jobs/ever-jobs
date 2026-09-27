# ADR 0001 — Crawl policy: honest identity and per-host pacing in the shared HTTP layer

| Field | Value |
|---|---|
| Status | Proposed — proceeding (AGENTS.md §9); owner review pending with Q-097 / Q-098 |
| Date | 2026-09-25 |
| Specs | [1690](../../.specify/specs/1690-crawl-policy/spec.md), [1691](../../.specify/specs/1691-softy-sitemap-discovery/spec.md); amended by [1714](../../.specify/specs/1714-crawl-caller-lock-and-host-policies/spec.md), [1715](../../.specify/specs/1715-softy-audit-hardening/spec.md) (see the end) |
| Amends | [constitution](../../.specify/memory/constitution.md) Art. 5.4, 6.1, 6.2, 11.2 (additions; no text removed) |
| Operator guide | [docs/CRAWL_POLICY.md](../CRAWL_POLICY.md) |

## Context

A hosted careers-site platform told us our crawler was impolite: unbounded bursts of
detail requests, a different proxy IP per request, a browser User-Agent that hid who we
are, and retries when the server pushed back. The audit showed the causes were in the
shared `HttpClient` and therefore affected every one of ~1,850 plugins: the client's
browser UA overrode every UA plugins declared, nothing bounded concurrency toward one
host across plugins, rotation was per request, and a long `Retry-After` was cut to 30 s.

The constitution and AGENTS.md described the HTTP client in terms of "UA rotation" and
bounded fan-out per source, and had no rule about how we identify ourselves or how hard
we may hit one host.

## Decision

1. **Identity.** By default every request carries an honest, configurable User-Agent
   that names Ever Jobs and links to the project (`identify` mode). A plugin may send its
   own UA only through an explicit manifest opt-in with a stated reason (an API that
   requires it). Operators can set a contact, a `From:` header, or any UA and mode.
2. **Pacing.** Every request made through `@ever-jobs/common` is paced by one
   process-wide limiter per host / registrable domain / site bucket (concurrency cap,
   minimum interval, jitter, adaptive slow-down, cool-down on `Retry-After`). Plugin
   fan-out code keeps `Promise.allSettled`; the limiter bounds what reaches each host.
3. **Back-off.** Never retry earlier than a server asks; a `Retry-After` beyond the
   configured maximum cools the whole bucket instead of being shortened.
4. **One policy object, six layers.** Preset → env → builtin host → plugin manifest →
   operator site/host → search caller, with provenance; the operator decides how much a
   caller may change.
5. **Nothing removed.** The previous behaviour is the `legacy` preset, and each piece of
   it is reachable on its own.
6. **Egress guard** in the same layer (private/internal destinations refused by
   default), closing the SSRF class of Q-092 for every plugin at once.

## Consequences

- A default search stays inside its 120 s deadline (simulated: 11.3 s for 800 Greenhouse
  requests plus a 100-wide fan-out to one host) thanks to builtin limits for bulk APIs.
- Some sites that only accept browsers may return 403 to the honest UA; per-site
  overrides exist, and the live A/B is recorded in Q-097.
- Per-host limits are per process; operators running several replicas size them for
  the replica count.
- New dependencies: `robots-parser` (new) and `tldts` (promoted from transitive) —
  justified in the [Spec 1690 plan](../../.specify/specs/1690-crawl-policy/plan.md) §4.

## Alternatives considered

- **Fix Softy only.** Rejected: the defects were global; the next operator complaint
  would be about another plugin.
- **Edit ~1,090 plugins to add delays.** Rejected: unmaintainable, and it cannot bound
  concurrency across plugins that share a host.
- **Change the default and drop the old behaviour.** Rejected by the owner's
  no-removal rule; `legacy` keeps it one setting away.
- **robots.txt on by default.** Rejected for now (load of ~1,800 fetches per search,
  deadline impact); opt-in per site/host/request or via the `strict` preset.

## Amendment — Specs 1714 and 1715 (2026-09-26)

A follow-up audit found that point 4 left the site owner's request at the mercy of the
search caller: on a default install (`EVER_JOBS_CRAWL_CALLER_OVERRIDES=any`, API-key auth
off) an anonymous caller could undo Softy's pace, identity and back-off, and code paths
other than the Softy plugin (liveness probes, JSON-LD) reached `*.softy.pro` under the
generic defaults. Additions, nothing removed:

- **A site owner's lock.** A plugin manifest or a builtin host policy may carry
  `callerOverrides`; the caller layer is filtered with the most restrictive of the global
  mode and those locks. The operator still has the final say: an operator per-site or
  per-host `callerOverrides` replaces the result, looser or tighter. A caller can never
  send a lock. Other sources keep the global `any` ([Q-126](../questions.md)).
- **Host-owned policies.** Builtin host policies accept `*.suffix` patterns and apply to
  every request to the host, whichever plugin makes it (`*.softy.pro`).
- **`stricter` really is stricter** (no parallel rate-limit bucket, an ordered proxy
  rotation, 429/503 kept in `retryStatuses`, `discovery` only towards the sitemap); the
  Spec 1690 comparators stay reachable (`EVER_JOBS_CRAWL_STRICTER_RULES=1690`).
- **Gentler pacing knobs**: an idle gap after each answer (`minGapMs`), a whole-bucket
  cool-down after server errors (`serverErrorCooldownMs`), both off by default, and
  `EVER_JOBS_CRAWL_FLEET_SIZE` for several processes behind one egress IP. Per-process
  limits and cool-downs remain a known limit ([Q-122](../questions.md)).

Design: [Spec 1714](../../.specify/specs/1714-crawl-caller-lock-and-host-policies/spec.md)
(shared layer and API) and [Spec 1715](../../.specify/specs/1715-softy-audit-hardening/spec.md)
(the Softy plugin); operator guide §6.4, §7.2 and §21 of
[CRAWL_POLICY.md](../CRAWL_POLICY.md).
