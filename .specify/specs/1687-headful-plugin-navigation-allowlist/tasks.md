# Tasks: 1687 — the browser goes where the plugin says, not where the caller says

- [x] T1 — `isAllowedRdwUrl` / `isAllowedTrossenroboticsUrl` in each plugin's constants. Acceptance: `URL`-parsed, http(s) only, apex or subdomain; rejects `https://evil.com/x.rdw.com`, `https://user@evil.com#.rdw.com`, `https://rdw.com.evil.com/jobs`, `file:///etc/passwd`, `http://169.254.169.254/`, `''`.
- [x] T2 — `startUrl(input)` in both services. Acceptance: an off-domain `companyUrl` is logged and the plugin's own board is read; an on-domain one with a query string is honoured verbatim.
- [x] T3 — Detail-href guard in both detail loops. Acceptance: an absolute off-site href on the board page is never fetched and the remaining card still returns a job.
- [x] T4 — Per-card `try`/`catch` + `N of M detail requests failed` summary in both. Acceptance: one rejecting detail navigation costs one job, not the board. RDW also keeps earlier pages when a later search page fails.
- [x] T5 — `unfilteredBudget` in RDW. Acceptance: `resultsWanted: 1` over a two-card board fetches one detail; with `searchTerm` set, both are fetched and the matching job still returns.
- [x] T6 — Bound `decodeFully` at 3 passes. Acceptance: the double-escaped fixture content still decodes fully (`Guidance & Navigation`, no `&amp;`, no `<p>`); a 60 KB nested chain returns in under 2 s.
- [x] T7 — Validate the Stratolaunch board token. Acceptance: `../../../internal`, `..%2F..%2Finternal`, `board?x=1`, `board#frag`, `board/jobs`, `has space` all fall back to `stratolaunch`; `stratolaunch-labs` and a Greenhouse `companyUrl` are honoured, the latter without its query string.
- [x] T8 — `empty` instead of `bad_input` for a verified-but-empty SuccessFactors CSB portal. Acceptance: the diagnostic names the portal; the unverifiable-origin case still reports `bad_input: missing companyUrl`.
- [x] T9 — `empty` diagnostic when either new plugin returns no jobs (Spec 1683).
- [x] T10 — Spec 5086 catalogue guard: a host declared twice by the *same* plugin is not a conflict. Acceptance: `source-company-trossenrobotics` declaring `trossenrobotics.com` and `www.trossenrobotics.com` passes; two different plugins claiming one host still fails.
- [x] T10b — Crawl failures reach the response. Acceptance: a page-one failure reports the classified cause rather than `empty`; a partial harvest returns its jobs plus a `N of M detail requests failed` diagnostic, which `JobsService` scores as `partial` (Spec 1680). Raised by Greptile on PR #84.
- [x] T11 — Docs: this spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry, `docs/questions.md` entry for the title-prefix conflict; `lint:docs` clean.
- [x] T12 — Verify: `tsc --noEmit -p tsconfig.base.json` clean, touched suites green, `npm run test:scripts` green.
