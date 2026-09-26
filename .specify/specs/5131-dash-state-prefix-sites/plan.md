# Plan: 5131 — Dash-prefixed US-state sites (`ST - X` / `ST-X`)

| Field | Value |
| --- | --- |
| Spec ID | 5131 |
| Status | implemented |
| Created | 2026-09-17 |

## Phases

1. **Lookup** — `STREET_SUFFIX_RE` tail matcher scoped to dash suffixes.
2. **`ST -`/`ST-` prefix** — in `parseCommaParts`' per-part loop, before
   the existing prefix-country / suffix-country / qualifier / last-part
   rules: `^[A-Z]{2}` + US code → `state`, remainder → `city` or `name`
   by street-suffix tail. Same check in `parseSingleLabel`'s bare-token
   path for unspaced `'MA-Boston'` (title-case suffix required).
3. **`City <descriptor>` split** — `splitCityDescriptor(part)`: longest
   suffix whose words all match `SITE_DESCRIPTOR_RE` → `{city, name}`.
   Applied to remaining parts only when `state` came from a `ST -`
   prefix; joins `name` when `city` is already claimed.
4. **Tests + verify** — spec cases; common suite; affected plugin suites;
   `tsc --noEmit`; `lint:docs`.

## Packages touched

- `packages/common` (`src/utils/location-parser.ts`,
  `__tests__/location-parser.spec.ts`).

## Risks

- Hyphenated non-geo labels (`'PA-Day'`, `'TX-Friendly'`) false-split —
  bounded by the literal-uppercase prefix + title-case suffix guard.
- Ordering sensitivity in the per-part loop — the state-prefix check must
  precede every consumer of the same dash; covered by the
  Morocco/Moldova/Canada regression cases.
