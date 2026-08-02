# Spec 5067 — Stop putting `mailto:` in `applyUrl` (carry the address in `emails`)

| Field | Value |
| --- | --- |
| Spec ID | 5067 |
| Slug | fix-mailto-applyurl |
| Status | done |
| Owner | agent |
| Created | 2026-07-15 |
| Last updated | 2026-07-15 |
| Supersedes | (none) |
| Related specs | (none) |


## Problem

Several plugins synthesize `applyUrl = mailto:<address>` for email-apply roles.
`applyUrl` is meant to hold a navigable web apply URL; an email address belongs
in `emails`. A `mailto:` in `applyUrl`:

- is not a web URL — any consumer that opens/validates `applyUrl` as http(s) breaks;
- duplicates data already carried (or that should be carried) in `emails`;
- has no independent precedent — every occurrence was authored in the same recent
  work, so it is self-minted, not an established convention.

The convention going forward (established by `source-company-vight`, Spec 5066):
the apply address lives in `emails`; `applyUrl` is left unset when applying is by
email.

## Scope

Remove `mailto:`-as-`applyUrl` from the plugins that synthesize it, keeping the
address in `emails`:

- `source-company-buildcover`
- `source-company-desktopmetal`
- `source-notion-pages`
- `source-ats-niceboard`

## Non-goals

- No change to the `JobPostDto` shape or new `applyUrl` validation (treat it as a
  real URL by convention, not by enforcement).
- Descriptive comments that merely mention "no `mailto:`" (reelementtech,
  solideon, galadyne, spikeaerospace, nanonuclearenergy) are accurate — leave them.
- The `mailto:` inside the SuccessFactors test fixture `descriptionHtml` is sample
  body content — leave it.
- No new plugin, no registration changes.

## Contract change

For the three company plugins (buildcover, desktopmetal, notion-pages):

- before: `emails` set; `applyUrl: emails[0] ? \`mailto:${emails[0]}\` : null`
- after: `emails` set; `applyUrl` omitted (undefined/null)

For `source-ats-niceboard`:

- `buildApplyUrl` returns only a real off-board `apply_url`, else null (the call
  site already falls back to the on-board `jobUrl`, a real URL).
- `emails` = de-duped union of `apply_email` (when present, first) and
  `extractEmails(description)`; null when empty. So the address the removed
  `mailto:` used to carry is preserved on `emails`.

## Test plan

- buildcover / desktopmetal / notion-pages specs: the existing email-apply
  assertions change from `applyUrl == mailto:<addr>` to `applyUrl == null`, with
  `emails` unchanged.
- niceboard: a new fixture-mocked unit spec (`niceboard.apply.spec.ts`) asserting:
    - `apply_email` only → `emails` carries it, `applyUrl` == on-board `jobUrl` (no `mailto:`);
    - `apply_email` + description addresses → de-duped union, `apply_email` first;
    - real `apply_url` → kept as `applyUrl`, `apply_email` still on `emails`.
- Per-package `tsc --noEmit` clean (repo-wide TS6059 rootDir noise is the baseline).