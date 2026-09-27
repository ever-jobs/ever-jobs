# Plan: 1751 — no plugin hands people an API URL as a job link

| Field        | Value       |
| ------------ | ----------- |
| Spec ID      | 1751        |
| Spec         | spec.md     |
| Status       | Implemented |
| Created      | 2026-09-25  |
| Last updated | 2026-09-25  |

## Approach

1. **Enumerate from source.** Parse every `packages/plugins/*/src/**/*.ts` with the
   TypeScript compiler; record every property assignment, variable declaration, shorthand
   property and `=` assignment named `jobUrl` / `jobUrlDirect` / `applyUrl`, render its value
   with same-plugin constants inlined, and bucket it by source (notes.md).
2. **Flag.** Pattern-match the rendered values and every helper they call for API shapes; list
   the source-response fields that feed the links and check each against the source's
   documented contract; read the code of every flagged plugin.
3. **Fix what has a public page**, through one shared helper (`firstPublicUrl`), each with a
   unit suite that is red against the pre-fix service.
4. **Guard.** Turn step 2 into a lint-style jest suite under `scripts/__tests__/` (it runs in
   CI's `npm run test:scripts` job), with named, self-expiring exceptions.

## Files

- `packages/common/src/utils/public-url.ts` (new), `packages/common/src/utils/index.ts`
  (one export line), `packages/common/__tests__/public-url.spec.ts` (new).
- `packages/plugins/source-reliefweb/src/reliefweb.{service,constants}.ts` +
  `__tests__/reliefweb.job-url.spec.ts`.
- `packages/plugins/source-navjobs/src/navjobs.{service,constants}.ts` +
  `__tests__/navjobs.job-url.spec.ts`.
- `packages/plugins/source-ats-hiringthing/src/hiringthing.service.ts` +
  `__tests__/hiringthing.job-url.spec.ts`.
- `packages/plugins/source-ats-loxo/src/loxo.service.ts` + `__tests__/loxo.job-url.spec.ts`.
- `packages/plugins/source-ats-bullhorn/src/bullhorn.service.ts` +
  `__tests__/bullhorn.job-url.spec.ts`.
- `packages/plugins/source-ats-ceipal/src/ceipal.{service,constants}.ts` +
  `__tests__/ceipal.job-url.spec.ts`.
- `scripts/__tests__/plugin-job-url-hosts.spec.ts` (new guard; T11 adds sinks 3–4, the
  fetch-helper exemption and the Zwayam exception).
- `packages/plugins/source-ats-carerix/__tests__/carerix.job-url.spec.ts` (T11, new),
  `packages/plugins/source-navjobs/__tests__/navjobs.job-url.spec.ts` (T12, 2 cases).

## T11 approach (guard gap)

1. Reproduce: mutant M7 (Carerix `buildJobUrl` → `https://api.carerix.com/v1/jobs/${id}`)
   passes the guard.
2. Measure before choosing a rule: across the tree, only 210 values sit under a `url` /
   `link` / `href` key and, judged like link fields, only Zwayam's is API-shaped; 200 helper
   names contain `url`, 34 of them return an API-shaped string — 32 fetch builders plus
   Ceipal and Zwayam. So record keys can be judged directly, while URL-named helpers need a
   usage test to leave fetch builders alone.
3. Exempt a URL-named helper only when every call site hands its result to a request
   (followed through locals, templates, `new URL()`, string methods and returning helpers);
   logs, truth tests and member reads are neutral; anything else makes it a link helper.
4. Prove with mutants of four shapes against the old guard (copied from HEAD to a temporary
   spec) and the new one, restoring each file with `git checkout`.

## Risks

- **Heuristic false positives.** A human page under `/api/` or `/v1/` would be refused at
  runtime (the next candidate wins) and flagged by the guard. `/v4/` (Paycom's portal) is
  deliberately not matched.
- **Blind spots.** Values that only exist at runtime are invisible to the guard. Links built
  into an intermediate record (`{ url: … }`) that a later mapper copies were invisible too
  (Zwayam; mutant M7) until T11 added the record-key and URL-named-helper sinks. What remains
  unseen: a link stored under another key by a helper whose name has no `url` in it
  (`{ page: buildPosting(id) }`), and helpers reached through another plugin or a DI token.
- **Merge overlap.** Another session edits `packages/common/src/utils/index.ts` (a different
  line), `docs/questions.md` and `docs/log.md` (both append at the top).

## Verification

- `npx jest packages/common/__tests__/public-url.spec.ts`
- `npx jest --testPathPatterns "job-url\.spec"` (6 adapter suites) — and against the pre-fix
  services: 13 of 22 fail.
- `npx jest scripts/__tests__/plugin-job-url-hosts.spec.ts` — and with `job.ref ??` put back
  in SmartRecruiters: fails.
- `npx tsc --project tsconfig.typecheck.json --noEmit`,
  `npx tsc --project apps/api/tsconfig.build.json --noEmit`, `npm run lint:docs`.
