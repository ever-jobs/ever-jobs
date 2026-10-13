# Spec: 5165 — `source-ats-jibe` plugin (Jibe / iCIMS Talent Cloud careers sites)

| Field | Value |
| --- | --- |
| Spec ID | 5165 |
| Slug | ats-jibe-plugin |
| Status | draft |
| Owner | agent |
| Created | 2026-09-29 |
| Related specs | 296-304 (source-ats-* adapter pattern) |

## Problem

Jibe (the iCIMS Talent Cloud candidate-experience platform) fronts the careers site of
many iCIMS customers: the listings page is a client-rendered SPA and the jobs live behind
a same-origin JSON API the SPA calls itself — `GET {origin}/api/jobs?page={n}` returning
`{jobs[].data, totalCount}`. A tenant whose classic `*.icims.com` board was replaced by a
Jibe front-end answers the iframe board URL (`?ss=1&in_iframe=1`) with a frame-buster
redirect to the Jibe site, so `source-ats-icims` harvests 0 jobs for it. Verified live:
`careers.rivian.com/api/jobs?page=1` reports `totalCount: 794` with icims apply links.

## Scope

New ATS plugin `packages/plugins/source-ats-jibe` (`Site.JIBE`, category `ats`, `isAts`):

- Tenant addressed by `companyUrl` (any Jibe page; its mount path becomes the detail-URL
  base — `…/careers-home/jobs` → `…/careers-home/jobs/{slug}`) or by `companySlug`
  (site host or full/partial URL; bare hosts use `{origin}/jobs/{slug}`).
- Enumerates `{origin}/api/jobs?page=N` — a fixed 10 jobs per page (`pageSize` is
  ignored) — until a page is empty, `totalCount` is covered, or `resultsWanted` is hit.
- Maps `jobs[].data`: `req_id`/`slug` → atsId + detail URL, `apply_url` → applyUrl /
  jobUrlDirect, city/state/country → location, `employment_type`,
  `posted_date`/`create_date` → datePosted, `category` → department, `description`,
  `hiring_organization` → companyName (host-derived fallback), remote via
  `location_type`/`remote` text; `req_id` dedup across pages.

## Non-goals

- Keywords/facet filtering beyond `resultsWanted` (the API supports them; pagination only).
- Changing `source-ats-icims` — the classic board endpoint stays correct for classic tenants.
- Discovering which companies are Jibe-fronted (a discovery-side concern).

## Contracts

- `IScraper.scrape(ScraperInputDto) → JobResponseDto`, same shape as other ATS plugins.
- Errors degrade to partial/empty result + classified scrape error; never throws.

## Test plan

- Unit: slug/URL resolution, page parsing, job mapping, pagination stop conditions
  (empty page, totalCount, resultsWanted), dedup, frame-buster/404 degrades.
- Live spot-check: `scrape` against `careers.rivian.com` returns jobs.
