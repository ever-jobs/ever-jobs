# Plan: 1698 — Markdown emphasis and line-break fidelity

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1698       |
| Spec         | spec.md    |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

One file changes. `markdownConverter` keeps its stock `TurndownService` for the previous output and
gains a second, edge-safe service built by `createEdgeSafeTurndownService()`:

1. `strongEdgeSafe` (`strong`, `b`) and `emphasisEdgeSafe` (`em`, `i`) return the content without
   delimiters when the node has a block descendant (`querySelector` through a structural cast —
   the repo compiles without the DOM lib), and `wrapInlineEmphasis(content, delimiter)` otherwise.
2. `wrapInlineEmphasis` splits on blank lines (spaces, tabs and zero-width characters count as
   blank), keeps the separators, and for each piece moves the leading and trailing padding
   (`[\s\u200B-\u200D\u2060\uFEFF]*`) outside the delimiters. The leading run is an anchored
   regex; the trailing run is a backward character scan (`endOfContent`), because an unanchored
   `[...]*$` is quadratic on a long mid-text run. A piece with no text keeps its line break, or
   becomes `''`.
3. `headingEdgeSafe` (`h1`–`h6`) splits on newlines, strips each line's padding, drops empty lines,
   joins the rest with one space, and renders exactly like turndown's heading rule (setext for
   h1/h2 under the default `headingStyle`, ATX otherwise).
4. `tidyMarkdown(md, html)` runs on the edge-safe output before the existing `.trim()`: empty the
   invisible lines, drop hard-break spaces before a blank line (line by line, with a
   backward scan), collapse `\n{3,}`. Skipped when the
   HTML contains `<pre`.
5. `markdownConverter(html, options?)` picks the service: `options.edgeSafe`, else the
   `EVER_JOBS_MARKDOWN_EDGE_SAFE` env switch, else on.

## 2. Phases

### Phase 1 — Tests first

- Deliverable: `description-converter.spec.ts`, red against the previous converter.
- Exit: fix cases fail, lock-in / already-correct / previous-output cases pass.

### Phase 2 — Converter

- Deliverable: rules, helper, tidy pass, switch.
- Exit: spec green; calling-plugin suites unchanged.

## 3. Packages Touched

| Package / file | Change |
| -------------- | ------ |
| `packages/common/src/converters/description-converter.ts` | edge-safe service, `wrapInlineEmphasis`, `tidyMarkdown`, `MarkdownConverterOptions`, `MARKDOWN_EDGE_SAFE_ENV` |
| `packages/common/__tests__/description-converter.spec.ts` | new suite (38 cases) |
| `packages/common/src/converters/index.ts` | (no change — `export *` already re-exports the file) |

## 4. Dependencies

None added. turndown `^7.2.0` (7.2.4 installed); only `addRule` and `options` are used.

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| A plugin spec pins the old whitespace | L | L | All 75 calling-plugin spec files run green with the fix |
| Stored MARKDOWN descriptions differ on the next scrape | H | L | Descriptions are in no hash or dedup key; the diff is mostly whitespace |
| Bold lost around block content | L | L | Accepted (spec D-03); the text itself is kept |
| Code blocks altered by the tidy | L | M | Tidy skipped whenever the HTML has `<pre` |
| Quadratic regex on remote HTML | M | M | Linear scans for trailing padding, heading folding and hard-break stripping; a 200k-run test pins it |

## 6. Rollback Plan

Set `EVER_JOBS_MARKDOWN_EDGE_SAFE=false` (process-wide, no deploy) or pass `{ edgeSafe: false }`
per call. Both route through the untouched stock `TurndownService` with no tidy pass, so the output
is byte-identical to the previous converter.

## 7. Migration Plan

None. Callers keep calling `markdownConverter(html)`; the second parameter is optional.

## 8. Verification

- `npx jest --testPathPatterns "packages/common/__tests__/description-converter"` — 38/38.
- Unit suites of every plugin that calls `markdownConverter` (75 spec files), with and without
  `EVER_JOBS_MARKDOWN_EDGE_SAFE=false`, plus the `packages/common` suites: 98 suites, 2654 tests,
  all green with the fix.
- `npx tsc --project tsconfig.typecheck.json --noEmit` — clean.
