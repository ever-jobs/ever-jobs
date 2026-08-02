# Spec: 5047 — source-company-desktopmetal

| Field | Value |
| --- | --- |
| Spec ID | 5047 |
| Slug | source-company-desktopmetal |
| Status | implemented |
| Plugin | `packages/plugins/source-company-desktopmetal` |
| Category | `company` (single company — Desktop Metal / desktopmetal.com) |
| Related specs | 5042, 5045, 5046 (prior company careers plugins); 5045 (shared salary `interval` hint) |

## Problem

Desktop Metal (`desktopmetal.com`) hosts its careers page with **no ATS**. The
page lists a handful of open roles grouped under department headings; each role
links to a **per-role PDF job description** under `/uploads/`, and applications
are sent to a single global email address. The role's substance — full
description and pay range — lives **only in the PDF**, not in the listing HTML.
No adapter existed, so these openings were not ingested.

Two properties make this heavier than a plain HTML company page:

- **The listing is client-rendered and Cloudflare-gated.** A plain HTTP GET of
  `/careers` returns a Cloudflare managed-challenge page (HTTP 403) — confirmed
  from both datacenter and residential IPs — so the challenge is JS-based, not
  IP-reputation-based. A real browser clears it automatically; a plain HTTP
  client never will.
- **The job content is in PDFs.** Description and salary must be extracted from
  PDF text. The PDFs themselves are **not** challenged — they are served over
  plain HTTP (HTTP 200) to any client.

## Approach

Two-stage fetch that matches where each obstacle actually is:

1. **Listing (one page, gated):** fetch `/careers` with a **stealth headless
   browser** (`BrowserPool.getPage({ stealth: true, proxy })`). A real browser
   clears the Cloudflare challenge and runs the JS that renders the openings.
2. **PDFs (open):** for each role, fetch its `/uploads/*.pdf` over the shared
   HTTP client (`responseType: 'arraybuffer'`) and extract the text.

### Listing structure

The rendered listing is a run of sibling elements under the "Current Openings"
heading:

- an `<h3>` department heading (e.g. `Engineering`, `Information Technology`,
  `Logistics`)
- one `<p><a href="/uploads/<file>.pdf">Title - Location</a></p>` per role
- a global apply block with `mailto:jobs@desktopmetal.com`

Parsing selects each `/uploads/*.pdf` anchor whose text is `Title - Location`,
splits title/location on the last ` - ` separator, and takes the department from
the nearest preceding non-empty `<h3>`. A `/uploads/*.pdf` link whose text is not
`Title - Location` (e.g. a footer brochure) is ignored.

### PDF text extraction

PDF text is extracted with **unpdf** (bundled pdfjs, no native dependencies).
Rather than the space-joined blob a plain merge produces, the extractor
reconstructs line and paragraph breaks from pdfjs's per-item `hasEOL` flags, so
the description keeps the document's line structure.

## Scope — one company plugin, NOT a shared plugin

This is a **single-company** plugin (like the prior company careers plugins,
Specs 5042/5045/5046): the domain, careers URL, and company name are baked into
constants; `companySlug` is ignored; `category:'company'`. The listing markup and
PDF layout are bespoke to this site, so there is no shared contract to
parameterize by an id.

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `id` | `desktopmetal-<pdf-file-stem>` (stable, unique per role) |
| `site` | `Site.DESKTOPMETAL` |
| `title` | listing anchor text (before the last ` - `) |
| `companyName` | `Desktop Metal` (constant; the careers brand) |
| `companyUrl` | `https://www.desktopmetal.com/careers` |
| `jobUrl` | the role's `/uploads/*.pdf` URL (the canonical per-role page) |
| `department` | nearest preceding `<h3>` heading |
| `location` | listing anchor text (after the last ` - `) via shared `parseLocationList` |
| `isRemote` | remote mention on the location; `null` when no location |
| `employmentType` | detected from PDF prose (`full-time` / `part-time` / `contract` / …) when present |
| `jobType` | `getJobTypeFromString(employmentType)` when it maps, else omitted |
| `description` | PDF text with reconstructed line structure |
| `compensation` | PDF pay range with the interval taken from the PDF's own label |
| `datePosted` | `null` (the PDFs carry no reliable posting date) |
| `emails` / `applyUrl` | global `jobs@desktopmetal.com` → `mailto:` |

### Per-role pay interval

The pay interval **varies per role** — some PDFs state an annual salary
("Salary Range … annually"), others an hourly rate ("Hourly Range … per hour").
Each role's interval is read from its own PDF label (or a per-unit token as a
fallback) and passed as the authoritative `interval` to the shared salary parser
(`ExtractSalaryOptions.interval`, Spec 5045), so the amount's magnitude never has
to guess the period. The numeric range is normalized first — unicode dashes → `-`
and stray commas that are not thousands separators removed
(`$110,000, – $150,000,` → `$110,000 - $150,000`).

## Non-goals

- A shared/parameterized careers plugin (this site's markup + PDF layout are bespoke).
- Modeling the email application flow beyond emitting the address.
- Per-role `datePosted` (not reliably present).
- Bundling a residential/unblocking proxy — the plugin accepts a caller-supplied
  proxy but ships none.

## Testing

- **Unit (fixture-based, no network):** the listing fetch and PDF fetch are
  isolated behind two protected seams so tests substitute captured ground truth —
  the rendered careers HTML and the real extracted PDF text (checked-in
  fixtures). Tests cover: three openings parsed with department/location/global
  apply email, the non-role `/uploads` PDF ignored, PDF body carried into the
  description, per-role pay interval (yearly and hourly) from each PDF label,
  employmentType/jobType detection, graceful degradation when a PDF fetch fails,
  input filters, and the empty-listing path.
- **Live path:** the PDFs are open, so the parse → PDF fetch → text extraction →
  salary pipeline is exercised against the real PDFs; the Cloudflare-gated
  listing fetch runs through the stealth browser (a caller-supplied proxy is used
  when datacenter egress is challenged).

## Acceptance

- The three current roles are produced with title, department, location, full
  description, and a compensation range carrying the correct per-role interval
  (two yearly, one hourly), plus the global apply email.
- Registered in the four standard places (Site enum, `ALL_SOURCE_MODULES`,
  tsconfig paths, jest moduleNameMapper); `api` build + plugin tests green.
