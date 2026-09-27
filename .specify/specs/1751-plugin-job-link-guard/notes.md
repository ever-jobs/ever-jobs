# Notes: 1751 — plugin job-link audit (2026-09-25)

| Field   | Value                                                                 |
| ------- | --------------------------------------------------------------------- |
| Spec ID | 1751                                                                  |
| Scope   | every `jobUrl` / `jobUrlDirect` / `applyUrl` assignment in `packages/plugins/*/src/**/*.ts` |
| Tree    | `origin/develop` `42f3ad08` + this branch's fixes                     |

## Method

- **Text count:** `rg '\b(jobUrl|jobUrlDirect|applyUrl)\s*[:=]'` over `packages/plugins/*/src/**/*.ts`
  → 1,616 lines before the fixes, 1,618 after (it also counts interface fields and misses
  `{ jobUrl }` shorthand, so it is not the audit base).
- **AST count (the audit base):** every `PropertyAssignment`, `ShorthandPropertyAssignment`,
  `VariableDeclaration` and `=` assignment named one of the three fields, parsed with the
  TypeScript compiler → **1,791 sites in 1,164 plugins** (jobUrl 1,438 · applyUrl 324 ·
  jobUrlDirect 29; company 970 · ATS 645 · job boards 176). Each value was rendered with
  same-plugin constants inlined, then bucketed below.
- **Flagging:** rendered values and every same-plugin helper they call were matched against
  `API_URL_PATTERN` (`api.` host label, `/api/`, `/v1/`, `graphql`, `/wday/cxs/`,
  `/rest-services/`, `.json`, …); reads of API-reference fields (`.ref`, `.self`, `.href` on
  API payloads) were listed; every flagged plugin's code was read.
- The static guard (`scripts/__tests__/plugin-job-url-hosts.spec.ts`) re-runs the flagging on
  every CI run: 1,165 plugins, 1,520 valued assignments (shorthand sites carry no value of
  their own; their `const` is counted).

## Buckets (all 1,791 sites, after the fixes)

| # | Source of the value | Sites | Verdict |
| --- | --- | ---: | --- |
| G | Greenhouse `absolute_url` (+ `boards.greenhouse.io/<co>/jobs/<id>` fallback) — 807 company plugins + `source-ats-greenhouse` | 808 | human (Greenhouse documents `absolute_url` as the posting page) |
| S | `{ jobUrl }` / `{ applyUrl }` shorthand — the value is the local `const` counted in another row | 271 | inherits |
| I | a field of the plugin's own normalised record (`job.url`, `listJob.jobUrl`, `opening.detailUrl`, …) set by that plugin's mapper | 220 | human — the mappers were read; each builds the link with a career-host helper (list below) |
| F | a field of the source API / feed response (runtime value) | 113 | human by the source's contract, except the rows marked in the table below |
| D | derived from the same posting's `jobUrl` (`applyUrl = jobUrl`, `${jobUrl}/apply`, `jobUrlDirect = jobUrl`) | 105 | inherits |
| B | helper / template on the tenant's career host (`this.buildJobUrl(…)`, `*JobUrl(…)`, `*_TEMPLATE.replace`) | 62 | human, except Ceipal (below) |
| H | `href` scraped from the fetched HTML page, resolved on the page host | 57 | human |
| P | public URL pattern built on the source's human host (`https://jobs.lever.co/…`, `…myworkdayjobs.com/…`) | 53 | human, except the flagged rows below |
| O | other (careers-page constants, regex captures from the page, `''` initialisers) | 47 | human (all 47 read) |
| R | RSS/Atom `<link>` of a board feed | 44 | human |
| N | `null` / `mailto:` | 11 | n/a |

**Bucket I — mappers checked** (the plugins whose own constants mention an API host, so the
record's `url` had to be traced by hand): apploi (`jobs.apploi.com/view/<id>`), beisen
(`<tenant>/portal/jobs/<id>`), dover (`app.dover.com/apply|jobs|careers/…`), eddy
(`app.eddy.com/careers/<org>/<id>`), employmenthero (`employmenthero.com/jobs/position/<id>/`),
greeting (`<tenant>.greetinghr.com/<locale>/o/<id>`), greythr (`apply_url`, else
`<tenant>…/hire/jobs/<slug>`), hirehive (`hosted_url`, else career origin), hrone (career
portal `?positionId=`), mokahr (`record.url`, else `app.mokahr.com/apply/…#/job/<id>`),
paycom (`www.paycomonline.net/v4/ats/web.php/portal/<key>/jobs/<id>`), pyjamahr
(`jobs.pyjamahr.com/<tenant>?job_uuid=`), recruitly (`applyUrl`, else board host), roubler
(`applyUrl`/`url`/`link`, else `app.roubler.com/…`), sense (career origin), sesamehr (careers
portal), sympa (`careers_url`, else `/o/<slug>`), turbohire (`publicUrl`/`applyUrl`, else
`portal.turbohire.co`), vidcruiter (`item.url`), workwise (`<site>/job/<id>-<slug>`) — all
human. **hibob** uses the job-ads API's `url` / `applyUrl` when present (field shape not
verified — no fixture, no live check) before its `…/jobs/<id>` careers pattern. **zwayam**
builds `https://api.zwayam.com/job_preview/?jobUrl=…&host=…` into the record: an API host that
`zwayam.constants.ts` documents as the platform's public share page (seen in shared job
links); unchanged and unverified here — the guard cannot see it because the link is built
into `{ url }` and copied later.

## Flagged rows (the audit's findings)

| Plugin | Field | Source (before) | Verdict | Action |
| --- | --- | --- | --- | --- |
| `source-ats-smartrecruiters` | jobUrl | `job.ref` — `https://api.smartrecruiters.com/v1/companies/<Co>/postings/<id>`; present on every posting | **leak, every posting** | fixed (Spec 1750) |
| `source-reliefweb` | jobUrl | `fields.url ?? entry.href`; `href` = `https://api.reliefweb.int/v1/jobs/<id>` | leak on fallback | fixed: `firstPublicUrl(fields.url) ?? https://reliefweb.int/node/<id>` |
| `source-navjobs` | jobUrl | `applicationUrl ?? sourceurl ?? item.url`; `item.url` = `/api/v1/feedentry/<uuid>`; non-URL `applicationUrl` text was also used verbatim | leak on fallback | fixed: public candidates only, else `arbeidsplassen.nav.no/stillinger/stilling/<uuid>`; `applyUrl` set |
| `source-ats-hiringthing` | jobUrl | `job.url ?? https://api.hiringthing.com/jobs/<id>` (not even a real API route) | api-host fallback | partly: `firstPublicUrl(job.url, companyUrl)` first; last resort kept (Q-110, guard exception) |
| `source-ats-loxo` | jobUrl, applyUrl | `url ?? apply_url ?? https://app.loxo.co/api/<slug>/jobs/<id>` | API fallback | partly: `firstPublicUrl(url, apply_url, companyUrl)` first; `applyUrl` public-only; last resort kept (Q-110, guard exception) |
| `source-ats-bullhorn` | jobUrl | always `https://public-rest<cls>.bullhornstaffing.com/rest-services/<token>/entity/JobOrder/<id>` | REST link, every posting | partly: caller's `companyUrl` first; last resort kept (Q-110, guard exception) |
| `source-ats-ceipal` | jobUrl, applyUrl | `apply_job ?? https://api.ceipal.com/<key>/job-postings/<id>/`; `applyUrl` copied the same URL | JSON fallback | partly: `apply_job` → caller portal → Indeed/Monster syndication links; `applyUrl` public-only; last resort kept (Q-110, guard exception) |
| `source-ats-zwayam` | jobUrl (via record) | `https://api.zwayam.com/job_preview/?jobUrl=<slug>&host=<host>&apiDomain=api.zwayam.com` | API host, documented as the public share page | unchanged; verify live (Q-110, tasks T10) |
| `source-ats-hibob` | jobUrl, applyUrl (via record) | the job-ads API's `url` / `applyUrl` when present | unverified | unchanged (runtime value) |

## Bucket F — source-response fields feeding a link

Verdicts are from each source's documented response contract, not live checks.

| Plugin | Field(s) read | Verdict |
| --- | --- | --- |
| 4dayweek, arbeitnow, echojobs, findwork, jobicy, joinrise, nodesk, remotive, workingnomads, solidjobs, careerjet | `url` of the board's public JSON | human (the board's posting page) |
| adzuna | `redirect_url` | human (Adzuna click-through) |
| authenticjobs | `company.url` (company site) else `authenticjobs.com/job/<id>` | human |
| builtin, dice, monster, jobsdb, jobstreet, reed, snagajob, dribbble | relative/absolute detail path on the board host | human |
| careeronestop | `URL` | human (the posting's own URL) |
| francetravail | `origineOffre.urlOrigine` else `candidat.francetravail.fr/offres/…` | human |
| getonboard | `links.public_url` | human |
| hackernews | `item.url` else `news.ycombinator.com/item?id=` | human |
| headhunter | `alternate_url` (the site page; `url` would be the API — not used) | human |
| himalayas | `applicationLink` | human |
| infojobs, jooble | `link` | human |
| jobdataapi | `application_url` else `jobdataapi.com/jobs/<slug>/` | human |
| jobtechdev | `webpage_url` else `application_details.url` | human |
| jsonld | `posting.url` else the page URL | human |
| naukri *(other session)* | `https://www.naukri.com${jdURL}` | human |
| navjobs | `applicationUrl`, `sourceurl` (public-only now) | human |
| nofluffjobs | `nofluffjobs.com/job/<posting.url>` | human |
| reliefweb | `fields.url` (public-only now) | human |
| remoteok | `url`, `apply_url` | human |
| simplyhired | `applyUrl` / `jobUrl` / `url` of the page's data | human |
| startupjobs, techcareers, web3career | `url` / `link` else board pattern | human |
| talroo | `onclick` (click-tracking redirect) | human redirect |
| themuse | `refs.landing_page` | human |
| usajobs | `PositionURI` | human |
| ziprecruiter *(other session)* | `job_url` / `url`, `apply_url` | human |
| ats-appone | `jobPostUrl` else `jobs.appone.com/job/<id>` | human |
| ats-avature, ats-harri, ats-workstream | the plugin's parsed/list `jobUrl` (+ `/apply`) | human |
| ats-bamboohr | `jobOpeningUrl` / `jobOpeningShareUrl` else `<co>.bamboohr.com/careers/<id>` | human |
| ats-beamery, ats-peoplestrong, ats-recruitly, ats-solides, ats-cleverconnect, ats-clearcompany, ats-easycruit, ats-factorial, ats-flatchr, ats-polymer, ats-recooty, ats-umantis, ats-varbi | the feed's `applyUrl` / `apply_url` / `redirectLink` variants | human |
| ats-comeet | `url_active_page` else `url` | human |
| ats-deel, ats-fountain, ats-trakstar, ats-workable | `url`, `apply_url`, `application_url` | human |
| ats-eploy | `Link` else `<tenant>/vacancies/<id>/` | human |
| ats-freshteam | `applicant_apply_link` else `<co>.freshteam.com/jobs/<id>` | human |
| ats-homerun | `application_url` else `app.homerun.co/<co>/<slug>` | human |
| ats-jobscore | `detail_url` else `careers.jobscore.com/jobs/<co>/<id>` | human |
| ats-joincom | `shareableUrl` else `join.com/jobs/<id>` | human |
| ats-lever | `hostedUrl` / `applyUrl` | human |
| ats-nodi_global | `magic_link` else `app.nodi.global/jobs/public/<id>` | human |
| ats-otys, ats-teamdash, ats-traffit, ats-vivahr, ats-talentlyft, ats-pinpoint | the feed's `url` / `Url` else a career-host pattern | human |
| ats-recruitee | `careers_url/<slug>` else the board's `/o/<slug>` | human |
| ats-rippling | detail/list `applyUrl` | human |
| ats-workday | detail `externalUrl` else `<co>.wd<n>.myworkdayjobs.com<externalPath>` | human host; the fallback omits the site segment — questionable, not an API (T10) |
| ats-hiringthing, ats-loxo | see *Flagged rows* | — |
| company-amazon | `urlNextStep` | human (amazon.jobs) |
| company-boeing, company-google | `url` / `apply_url` else the careers pattern | human |
| company-canekast, company-desktopmetal | `pdfUrl` | human-viewable PDF, not an HTML page (T10) |
| company-avalanchefusion, company-renewmfgsol, company-soundryx, company-spikeaerospace | detail/record `applyUrl` / `url` / `link` from the scraped page | human |

## Plugins owned by another session (reported only)

| Plugin | Field | Source | Verdict |
| --- | --- | --- | --- |
| `source-linkedin` | jobUrl | `a[href]` of the guest search card, query stripped | human |
| `source-glassdoor` | jobUrl | `seoJobLink ?? jobLink`, made absolute on the Glassdoor host | human |
| `source-ziprecruiter` | jobUrl, jobUrlDirect | `job_url ?? url`; `apply_url` | human |
| `source-naukri` | jobUrl | `https://www.naukri.com${jdURL}` (else `/job/<id>`) | human |

## Questionable but human (not fixed here)

- `source-ats-workday`: when the detail has no `externalUrl`, the fallback joins
  `externalPath` to `https://<co>.wd<n>.myworkdayjobs.com` without the site segment.
- `source-ats-oracle`: `ExternalUrl` else `<baseUrl>/careers/job/<slug>`, where `baseUrl` is
  the bare tenant host — not the documented `…/hcmUI/CandidateExperience/…` path.
- `source-company-canekast`, `source-company-desktopmetal`: the posting is a PDF.

## T11 — links built one step early (2026-09-25)

**Measured before choosing the rule** (TypeScript AST over all 1,871 plugin `src` trees):

- Values under an object key `url` / `link` / `href` (literal, shorthand, member assignment):
  210; judged like a link field, exactly one is API-shaped — Zwayam's
  `url: this.buildJobUrl(…)` (`https://api.zwayam.com/job_preview/…`). With every key ending in
  `url|link|href|uri` (1,809 sites) the only extra hits are the four last-resort plugins.
- Function / method / arrow-constant names containing `url`: 200 distinct names; 34 helpers
  return an API-shaped string. 32 are fetch builders (`adpListUrl`, `adpDetailUrl`,
  `apploiProfileUrl`, `buildBoardUrl` ×2, `eddyJobsListUrl`, `eddyJobDetailUrl`,
  `employmentHeroJobsUrl`, `buildFeedUrl` ×3, `jazzhrApiUrl`, `buildJobsPageUrl`,
  `manatalListUrl`, `mokahrJobsApiUrl`, `nodiGlobalJobsUrl`, `buildPageUrl`, `buildBaseUrl`,
  `recruitlyJobFeedUrl`, `ripplingDetailUrl`, `roublerFeedUrl`, `submit4jobsApiUrl`,
  `sympaOffersUrl`, `vidcruiterFeedUrl`, `workableDetailUrl`, `buildWorkdayUrl`,
  `buildWorkdayDetailUrl`, `HN_ITEM_URL`, headhunter `buildUrl` ×2, …) — every call site
  hands the result to `get` / `post` / `fetchJson` (or a local that does). The other two are
  Ceipal's and Zwayam's `buildJobUrl`. A name-only rule would therefore need a hand list of
  fetch words (and `…DetailUrl` is a link in some plugins, a fetch in others); the usage test
  needs none.
- Simulated mutants (each URL-named builder's last `return` replaced by an API URL, 230
  helpers): the pre-T11 guard missed 136 of them — fetch builders among them, where missing is
  right, but also link builders such as Carerix/Oleeo/Paycor/PyjamaHR `buildJobUrl`,
  `cvwarehouseJobUrl`, `paycomJobUrl` and `breathehrVacancyUrl`.

**After T11:** 197 record links, 348 URL-named link helpers judged, 93 exempted as fetch
helpers; findings only in bullhorn, ceipal, hiringthing, loxo and zwayam (all named).

**Mutants** (applied to the real tree, guard tree tests run with the pre-T11 guard copied from
HEAD `381a3882` and with the new one, file restored with `git checkout` after each):

| # | Shape | Plugin / file | Mutation | pre-T11 guard | T11 guard |
| --- | --- | --- | --- | --- | --- |
| M7 | method helper → record `url` → `jobUrl: job.url` | `source-ats-carerix` `carerix.service.ts` | `buildJobUrl` returns `https://api.carerix.com/v1/jobs/${jobId}` | pass (missed) | **fail**: `record url` :338, `helper buildJobUrl()` :451 |
| M8 | arrow helper in a constants file | `source-ats-breathehr` `breathehr.constants.ts` | `breathehrVacancyUrl` returns `https://api.breathehr.com/v1/vacancies/${…}` | pass (missed) | **fail**: `record url` (service :196), `helper breathehrVacancyUrl()` |
| M9 | template kept in a `Map`, looked up by language | `source-ats-cvwarehouse` `cvwarehouse.constants.ts` | `new Map([['en-US', 'https://api.cvwarehouse.com/v1/jobs/{job}']])`; `cvwarehouseJobUrl` returns `(MAP.get(lang) ?? ORIGIN).replace('{job}', jobId)` | pass (missed) | **fail**: `record url` (service :311), `helper cvwarehouseJobUrl()` |
| M10 | inline template straight into the record (no helper) | `source-ats-carerix` `carerix.service.ts` | `url: feedJob.url ?? \`https://api.carerix.com/v1/jobs/${jobId}\`` | pass (missed) | **fail**: `record url` :338 |

M7 also turns the new runtime suite `carerix.job-url.spec.ts` red (2 of 3).

## T12 — NAV: the fallback id is the public ad id

- **Source** (navikt/pam-stilling-feed, HEAD `45cc8c49`, 2026-09-24):
  `FeedService.kt` stores each ad as `FeedItem(uuid = UUID.fromString(ad.uuid), …)` and its
  page row with `feedItemId = feedItem.uuid`; `FeedAd.kt` `FeedLine.fraFeedPageItem` emits
  `id = feedItemId`, `url = "/api/v1/feedentry/${feedItemId}"`,
  `_feed_entry.uuid = feedItemId`; `mapAd` sets `link = "$stillingUrlBase/${source.uuid}"`;
  `naiserator-prod.json` sets `stilling_url_base = https://arbeidsplassen.nav.no/stillinger/stilling`.
- **Live** (1 GET): `https://arbeidsplassen.nav.no/stillinger/stilling/0862f420-5aea-4532-af73-43156a9e7b7f`
  → 200 `text/html`, title "Midlertidig stilling som prosjektmedarbeider - arbeidsplassen.no",
  the uuid shown as *Stillingsnummer* and as `adData.id` (status `ACTIVE`).
- So `NAVJOBS_PUBLIC_AD_URL/<_feed_entry.uuid ?? id>` is exactly NAV's own `ad_content.link`.
- Side finding (not changed): the list feed's `_feed_entry` carries only `uuid`, `status`,
  `title`, `businessName`, `municipal`, `sistEndret`. `navjobs.types.ts` also declares
  `description`, `sourceurl`, `applicationUrl` there; those live only in
  `/api/v1/feedentry/<uuid>` (`ad_content`), which the plugin never fetches — so in practice
  NAV jobs always link the arbeidsplassen page and carry no description.
