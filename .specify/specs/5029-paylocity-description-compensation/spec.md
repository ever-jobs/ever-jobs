# Spec: 5029 — Paylocity full-body description, structured compensation, clean company name

| Field | Value |
| --- | --- |
| Spec ID | 5029 |
| Slug | paylocity-description-compensation |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5020, 5022, 5018, 5019 |

## Problem

The Paylocity detail parser (Spec 5020) has three correctness bugs, all
observed on live `recruiting.paylocity.com` postings:

1. **Description drops visible sections.** `parseDetail` takes the description
   **JSON-LD-first** (`ldDescription ?? htmlParsed.description`). The embedded
   schema.org `JobPosting.description` carries only the body of the section
   literally titled "Description" — it omits every other visible section
   ("Salary Description", "Requirements", …). Because a usable ld+json
   description is almost always present, the plugin's own full-body HTML parse
   (`parseDetailHtml`, which already concatenates *every* section) is silently
   discarded. The emitted `description` is therefore narrower than the visible
   posting body.

2. **Compensation ignores structured pay.** The plugin resolves compensation
   with `resolveCompensation({ structured: null, text: description })` — i.e.
   text-parsing the (truncated) description and never reading the structured
   `baseSalary` that the detail ld+json provides. When the salary is not inline
   in the "Description" prose (it lives in the dropped "Salary Description"
   section, e.g. `$27.00 - $35.00/hour`), compensation comes out **empty**. It
   only succeeds by luck when the pay happens to appear in the description text.

3. **`companyName` carries the Paylocity module id.** `ModuleTitle` is the
   company name with the module id appended in brackets, e.g.
   `"SendCutSend Inc [175255]"`, and the plugin uses it verbatim, shipping the
   bracketed id to users.

## Scope

- **Description = full visible body.** Source the description from the detail
  page's `job-listing-header` sections (every section concatenated — already
  implemented in `parseDetailHtml`). Use the ld+json `JobPosting.description`
  only as a fallback when no HTML sections parse.
- **Structured-first compensation.** Read the ld+json `baseSalary` into a
  `CompensationDto` (via the shared `jobPostingLdToCompensation`) and pass it as
  `structured` to `resolveCompensation`; the (now full-body) description text
  remains the fallback. Set `salarySource` to `'structured'` when `baseSalary`
  is present, else `'description'` — matching the `source-jsonld` /
  `workatastartup` / `manatal` convention.
- **Strip the module id from `companyName`.** Remove a trailing ` [\d+]` from
  `ModuleTitle`.

## Non-goals

- No change to the board/detail endpoints, the `window.pageData` parse, or the
  `job-listing-header` section parser itself.
- No change to location / `isRemote` / `workFromHomeType` / date / `jobType`
  mapping.
- No change to the shared `resolveCompensation` / `jobPostingLdToCompensation`
  helpers (Spec 5018) or the ld+json extractor (Spec 5022).
- No plugin imports another plugin.

## Contracts

- `JobPostDto` shape unchanged.
- A posting whose visible body has a "Salary Description" (or any non-"Description")
  section now includes that section's text in `description`.
- A posting with ld+json `baseSalary` `{ min, max, unitText }` yields a
  `compensation` from that structured range with `salarySource: 'structured'`,
  regardless of whether the pay also appears in the description prose.
- A posting with no `baseSalary` but a salary range in the (full-body)
  description still yields `compensation` via the text fallback with
  `salarySource: 'description'` (behaviour-preserving for that case).
- `companyName` for `ModuleTitle` `"SendCutSend Inc [175255]"` is
  `"SendCutSend Inc"`; a `ModuleTitle` with no bracketed id is unchanged.

## Test plan

- **Paylocity service**, new / updated cases:
    - structured-first: detail with ld+json `baseSalary` → `compensation` from
      the structured range, `salarySource: 'structured'`, `interval` from
      `unitText`.
    - module-id strip: `ModuleTitle` `"SendCutSend Inc [175255]"` →
      `companyName: 'SendCutSend Inc'` (no `[`).
    - full-body description: a detail whose ld+json `description` is only the
      "Description" section while a "Salary Description" section is also visible
      → emitted `description` contains the "Salary Description" text.
    - text fallback: detail with no `baseSalary` but a salary range in the
      description → `compensation` via text, `salarySource: 'description'`.
- Existing Paylocity suites stay green (board mapping, detail overlay,
  remote/workFromHomeType, fail-safe on detail error, resultsWanted, empty
  cases).

## Risks

- A non-"Description" section heading is now included in the body text (under an
  `<h3>` label), making descriptions slightly longer. This is the intended,
  more-complete output and matches what a user sees on the page.
- The fix never *removes* description content or compensation relative to today;
  it only adds the previously-dropped sections and a more reliable pay source.
