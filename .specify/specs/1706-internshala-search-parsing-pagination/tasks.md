# Tasks: 1706 — Internshala: a search that searches, one posting per card, and honest paging

- [x] T1 — URL builder and robots guard (`buildListingPath` / `buildListingUrl` / `isRobotsSafeUrl` / `assertRobotsSafe`). Acceptance: `keywords-{kw}/` for both streams, `page-N/` from page 2, `%20` for multi-word terms, no `,` `?` `#` `%3F` `%3D` for any input, the narrow city and work-from-home forms, `Bengaluru` → `bangalore`, and never the old `/jobs/<term>`, `-in-` or `/work-from-home` suffix forms.
- [x] T2 — One card per `div.individual_internship` (the `.internship_meta` child no longer double counts); a card without a title or detail link is skipped with a reason. Acceptance: 4 cards / 4 ids on the jobs fixture where the old selector matched 8.
- [x] T3 — `is-<internshipid>` ids read through the lower-cased attribute, element-id and url-hash fallbacks; `INTERNSHALA_ID_SCHEME=url-hash` restores the old ids.
- [x] T4 — Locations: per-city anchors and comma lists split, work-from-home label removed, "(Hybrid)" and the office-days popover never in a city, India stamped unless "International", remote read from the location row only (a "WFH" snippet no longer makes a card remote).
- [x] T5 — `parseInrPay`: pay row only (never the post-internship offer), Indian digit grouping, job yearly / internship monthly without a period, lump sum `interval: null`, "Unpaid" / "Competitive salary" → `null`, period tokens through `intervalFromPeriodToken`, defensive LPA.
- [x] T6 — `parsePostedAge` + `resolvePostedTime`: label buckets, guarded slug-epoch refinement (`INTERNSHALA_SLUG_TIMESTAMP=false` disables it), Spec 1696 fields via `postedTimeFields`.
- [x] T7 — Page signals (`isLastPage`, highest pagination page, normalised canonical, challenge detection) and `classifyCanonical`.
- [x] T8 — `planSearch`: `jobType` → streams/filters (unsupported values make no request), city/remote narrowing, paging, description depth; `resolveInternshalaOptions` for the four env switches.
- [x] T9 — Service orchestration: one page per stream per round, 2–5 s sequential pauses, stop rules and page cap, canonical guard with keyword fallback (also on a narrow 404), round-robin merge + offset, sequential detail budget, first-error diagnostics, honest default UA, `input.userAgent` and transport options passed to the client, redirects pinned to the board host.
- [x] T10 — Synthetic fixtures (jobs page 1 and last page 2, internships page 1, empty, unfiltered root, detail, challenge).
- [x] T11 — `internshala.parser.spec.ts` (57 tests) and `internshala.service.spec.ts` (34 tests); 91/91.
- [x] T12 — Live e2e (≤ 3 results, `board`): keyword relevance, unique `is-<n>` ids, INR currency, multi-word internship search; both pass against the live board.
- [x] T13 — `tsconfig.json` for the package; `src/index.ts` exports the parser, constants and types.
- [x] T14 — README "Internshala" section, CHANGELOG entry, `docs/index.md` / `docs/log.md` rows (integrator).

Integration 2026-09-25: README Internshala section, `docs/index.md` / `docs/log.md` rows. The root `CHANGELOG.md` is not maintained past 0.1.0, so the change is recorded in `docs/log.md` and `docs/API_CHANGELOG.md` instead.
