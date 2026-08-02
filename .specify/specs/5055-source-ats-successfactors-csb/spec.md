# Spec: 5055 — source-ats-successfactors Career Site Builder reader

| Field | Value |
| --- | --- |
| Spec ID | 5055 |
| Slug | source-ats-successfactors-csb |
| Status | implemented |
| Plugin | `packages/plugins/source-ats-successfactors` (extends existing) |
| Related specs | 5038 (icims server-rendered board over HTTP + Cheerio), 5040 (jobvite board + detail), 5041 (prismhr board + detail hybrid) |

## Problem

The `source-ats-successfactors` plugin only read the SuccessFactors **OData API**
(`https://{instance}.successfactors.com/odata/v2/JobRequisitionPosting`), with a
native careersection HTML fallback. But many SuccessFactors employers **do not
publish public OData** and instead expose jobs through the **Career Site Builder
(CSB) / Recruiting Marketing (RMK)** portal — frequently on their **own custom
domain** (e.g. `careers.example.com`) with no `successfactors` string in the
hostname.

For such a tenant the plugin returned nothing:

- OData probe → `404` (not enabled for the tenant).
- Native careersection HTML fallback → wrong surface (custom-domain CSB pages do
  not use the `/career?company=` careersection layout or its selectors).

The custom domain also masks the ATS from the upstream harvesting pipeline: the
SuccessFactors fingerprints (`careerN.successfactors.com`, `company=C<digits>P`,
`/tile-search-results/`) live only inside the page HTML, not in the hostname. The
upstream pipeline's SuccessFactors detection + identity recovery is out of scope
here; this spec covers the ever-jobs harvest path once such a tenant is routed to
this plugin.

## Scope

Add a **third read path** to the existing plugin — a CSB reader — behind a
deterministic switch. One plugin, three internal surfaces of the *same*
requisitions:

```
1. OData API        (structured; preferred when an instance is known)
2. CSB / RMK portal (this spec; public surface for tenants without OData)
3. careersection    (native HTML; last-resort fallback)
```

### Selection (deterministic, no guessing)

```
scrape(input):
  slug    = input.companySlug           # "{instance}:{companyId}", optional
  csbBase = origin(input.companyUrl)     # custom-domain portal, optional

  if instance:  jobs = OData(instance, companyId);  if jobs → return   # 404/empty ⇒ fall through
  if csbBase:   jobs = CSB(csbBase);                if jobs → return
  if instance:  return careersection(instance, companyId)              # last resort
  return []
```

The OData request is itself the probe: a tenant without OData 404s/errors and
yields zero, which is the signal to try CSB. CSB is addressed by the portal URL
(`companyUrl`), not the instance subdomain.

### CSB reader — list + detail hybrid

The board + detail hybrid of Specs 5040 / 5041, fetched over plain HTTP with the
shared client + Cheerio (like Spec 5038 — CSB portals are server-rendered and
**not** Cloudflare-gated):

```
GET {base}/tile-search-results/?q=&sortColumn=referencedate&sortDirection=desc&startrow={N}
  → parseCsbTiles: every <a href="/job/{slug}/{jobId}/"> → {jobId, title, jobUrl}
  → de-dupe by jobId (tiles repeat across desktop/tablet/mobile variants)
  → paginate startrow += 25 until a page yields no new ids (cap SF_CSB_MAX_PAGES)

GET {base}/job/{slug}/{jobId}/   (bounded fan-out, one per role)
  → parseCsbDetail: schema.org JobPosting *microdata* (itemprop=..., NOT JSON-LD)
```

### Field mapping (CSB path)

| JobPostDto field | Source |
| --- | --- |
| `atsId` | numeric job id (path token `/job/{slug}/{jobId}/`) |
| `id` | `sf-csb-{jobId}` |
| `atsType` | `successfactors` |
| `site` | `Site.SUCCESSFACTORS` |
| `title` | detail microdata `[itemprop=title]`; tile anchor text fallback |
| `companyName` | detail microdata `[itemprop=hiringOrganization]`; `companyId` fallback |
| `jobUrl` / `applyUrl` | absolute `{base}/job/{slug}/{jobId}/` |
| `location` | detail microdata `jobLocation › address` (`addressLocality`/`addressRegion`/`addressCountry`) |
| `isRemote` | location string contains `remote` |
| `datePosted` | detail microdata `[itemprop=datePosted]` (`content` attr → `YYYY-MM-DD` via `toDateOnly`) |
| `description` | detail microdata `[itemprop=description]` innerHTML (formatted per `descriptionFormat`) |
| `jobFunction` | detail microdata `[itemprop=industry]` |
| `emails` | extracted from the description body |

### Non-goals

- **No** change to the OData path or the native careersection fallback — both
  stay as-is; CSB slots in between.
- **No** upstream-pipeline detection/identity-recovery work — routing a
  custom-domain SuccessFactors employer to this plugin is out of scope here.
- **No** JSON-LD assumption for CSB detail pages — they emit schema.org
  **microdata**, so the shared JSON-LD extractor does not apply; a small
  microdata reader is used instead.
- **No** `employmentType` from CSB — the observed CSB detail microdata does not
  expose it, so `jobType` is left null on this path (OData still maps it).
- **No** portals hosted under a sub-path — the CSB base is taken as the portal
  origin (scheme + host). Sub-path-hosted CSB instances are logged as an open
  question rather than guessed.

## Contracts

### Portal resolution

- `companyUrl` = the CSB portal URL; the reader uses its **origin**
  (`resolveCsbBaseUrl` → `new URL(companyUrl).origin`).
- Missing / non-absolute `companyUrl` → CSB path skipped.
- `companySlug` (`{instance}:{companyId}`) remains optional — it drives OData and
  supplies the `companyName` fallback, but CSB works without it.

### Tile parse

- Every `<a href>` matching `/job/{slug}/{jobId}/` → a list item; `jobId` is the
  trailing numeric segment (a zip code embedded in the slug is not mistaken for
  it — the id must follow a `/`).
- De-duped by `jobId` (first occurrence wins).
- Pagination stops when a page adds no new ids (guards a portal that clamps
  `startrow` and re-serves page one), on an empty page, at `resultsWanted`, or at
  `SF_CSB_MAX_PAGES`.

### Detail parse

- Scope requires a `[itemtype*="JobPosting"]` element; otherwise the page yields
  no detail (role still emitted from the tile).
- Microdata values read from the `content` attribute (meta tags) or element text.
- A missing/failed detail page still emits the role from tile fields (title from
  the anchor), with detail-only fields null.

### Graceful degradation & safety

- No tiles / all fetches fail → `[]`.
- Per-role detail fan-out is bounded (`Promise.allSettled`, concurrency cap) so
  one slow/failed page never nukes the batch.
- Inter-page pacing via `randomSleep` (reuses the existing SF delay bounds).
- All logging via NestJS `Logger`; no `console.log`; no secrets logged.

## Test plan

### Unit tests (protected fetch seams stubbed; no network)

- Tile + detail microdata → full `JobPostDto` (title, company from
  `hiringOrganization`, structured location, `datePosted` normalized,
  description, emails, `atsId`, absolute `jobUrl`).
- Pagination across two tile pages + de-dupe of repeated anchors.
- `resultsWanted` cap.
- Detail page missing → role still emitted from the tile title.
- No `companySlug` and no `companyUrl` → `[]`.
- Portal with no tiles → `[]`.
- Helpers: `resolveCsbBaseUrl` (origin / rejects non-URL), `buildSfCsbTileUrl`
  (pagination params), `SF_CSB_JOB_LINK_RE` (id extraction ignoring a zip in the
  slug), `htmlLooksLikeCsb` (custom-domain fingerprint detection vs a plain
  marketing page).

### Live validation

- CSB portals are plain server-rendered HTML (HTTP 200, no Cloudflare), so the
  list (`/tile-search-results/`) and detail (`/job/.../{id}/`) shapes were
  observed live from a representative custom-domain tenant. The microdata mapping
  is anchored on the stable schema.org `JobPosting` `itemprop` contract.
