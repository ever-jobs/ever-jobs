# Tasks: 5167 — source-tesla browser fallback when the plain board GET fails

| Field | Value |
| --- | --- |
| Spec ID | 5167 |
| Slug | tesla-browser-fallback |
| Status | draft |
| Owner | agent |
| Created | 2026-10-01 |

- [x] tesla.constants.ts: careers-page URL, launch args, timeouts, browser
      sentinels; header note → HTTP-first + lazy fallback.
      **AC**: file compiles; no runtime playwright reference.
- [x] tesla.service.ts: `scrape()` falls back on `board === null`;
      `scrapeViaBrowser` → headless `browserAttempt` → headed once when
      still blocked; nav `domcontentloaded` + settle + 3× board poll +
      in-page detail fetches per budget; emits `site: Site.TESLA`;
      never throws.
      **AC**: HTTP-success path byte-identical; fallback returns DTO always.
- [x] tests: (a) HTTP fail + browser board → jobs emitted `Site.TESLA`;
      (b) HTTP fail + playwright missing → empty DTO, sentinel logged;
      (c) HTTP fail + nav fail → empty DTO; (d) headless blocked →
      headed retry asserted (launch called headless then headed).
      **AC**: jest green for source-tesla.
- [x] default `descriptionDepth`: `detail-25` → `board` in
      `source-tesla` AND `source-tesla-playwright`; comment explains
      detail-all ≈ ~8k+ sequential requests (latency + per-IP rate
      limits), detail-25 = arbitrary partial set.
      **AC**: budget-map tests assert `'board'` default; pre-existing
      detail-path tests pin explicit `'detail-25'`.
- [x] terminology: docs/comments describe only the observable ("plain
      GET fails") — no flagged-IP/blanket-rule assumptions; companion
      documented as unwired reference code.
- [x] docs: index.md row + log.md entry.
      **AC**: docs lint clean.
