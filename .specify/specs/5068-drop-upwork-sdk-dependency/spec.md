# Spec 5068 — Drop the `@upwork/node-upwork-oauth2` dependency (fork does not use Upwork)

| Field | Value |
| --- | --- |
| Spec ID | 5068 |
| Slug | drop-upwork-sdk-dependency |
| Status | done |
| Owner | agent |
| Created | 2026-07-15 |
| Last updated | 2026-07-15 |
| Supersedes | (none) |
| Related specs | (none) |


## Problem

`npm audit` reports several advisories with **no upstream fix**, all rooted in the
deprecated `request` HTTP stack pulled in transitively by
`@upwork/node-upwork-oauth2`:

- `request` — SSRF (GHSA-p8p7-x288-28g6)
- `tough-cookie` — prototype pollution (GHSA-72xf-g2v4-qvf3)
- `uuid` (<11.1.1, via `request`) — missing buffer bounds check (GHSA-w5hq-g745-h8pq)

`request` is unmaintained, so these cannot be patched while the dependency stays.
This fork does not use the Upwork source.

## Scope

- Remove `@upwork/node-upwork-oauth2` from root `package.json` `dependencies`.
- Load the SDK **lazily and guarded** in `source-upwork` so the package builds and
  the plugin stays registered, but the vulnerable tree is no longer installed.
- Keep graceful degradation: unconfigured Upwork already returns empty results; a
  configured-but-SDK-absent path throws a clear, self-describing error instead of
  crashing DI startup.

## Non-goals

- No removal/unregistration of the `source-upwork` plugin or `Site.UPWORK`.
- No change to `JobPostDto`, other plugins, or Upwork's mapping logic.
- No `npm audit fix --force` (would force breaking bumps of `@modelcontextprotocol/sdk`,
  `express`, `nest-commander`); the remaining advisories are dev/build-tooling DoS
  issues, handled separately if desired.

## Contract

- `UpworkService` construction never throws (env-configured but SDK-missing ⇒ warn +
  stay unconfigured ⇒ `scrape()` returns `[]`).
- `createApiClient` / GraphQL execution call `loadUpworkSdk()`, which `require`s the
  SDK on demand and throws a descriptive error if it is not installed.
- Reinstalling `@upwork/node-upwork-oauth2` re-enables Upwork with no code change.

## Test plan

- `jest --testPathPatterns source-upwork` (unconfigured path) → green.
- `npm run build` (nx build mcp+api+cli) → green.
- `npm ls request tough-cookie @upwork/node-upwork-oauth2` → absent; audit no longer
  lists the request/tough-cookie/uuid "No fix available" advisories.