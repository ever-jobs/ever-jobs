# Tasks: 1698 — Markdown emphasis and line-break fidelity

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Tests first

- [x] T01 — Spec suite `packages/common/__tests__/description-converter.spec.ts`
  - **Files:** `packages/common/__tests__/description-converter.spec.ts`
  - **Acceptance:** synthetic inputs only; includes the list-spacing lock-in
    (`**Requirements:**\n\n*   TypeScript\n*   Node`); red against the previous converter with
    24 failures, and the 13 passing cases are exactly the lock-in, already-correct and
    previous-output ones.

## Phase 2 — Converter

- [x] T02 — `wrapInlineEmphasis(content, delimiter)`
  - **Files:** `packages/common/src/converters/description-converter.ts`
  - **Acceptance:** edge whitespace, hard breaks and zero-width characters go outside the
    delimiters; per-paragraph wrapping across blank or zero-width-only lines; a break-only piece is
    kept, a space-only piece gives `''`.
- [x] T03 — `strongEdgeSafe` / `emphasisEdgeSafe` rules
  - **Files:** `packages/common/src/converters/description-converter.ts`
  - **Acceptance:** `<strong>OUR HIRING PROCESS:<br/><br/></strong><ul>…` →
    `**OUR HIRING PROCESS:**\n\n*   …`; nested `strong>em`, `span` wrappers and list items handled;
    block content inside inline emphasis drops the delimiters.
- [x] T04 — `headingEdgeSafe` rule
  - **Files:** `packages/common/src/converters/description-converter.ts`
  - **Acceptance:** `<h2>Title<br></h2>` → `Title\n-----`; `<h3>Title<br>Sub</h3>` →
    `### Title Sub`; an ordinary heading renders as before; a break-only heading emits nothing.
- [x] T05 — `tidyMarkdown` pass
  - **Files:** `packages/common/src/converters/description-converter.ts`
  - **Acceptance:** `<div>A<br><br><br><br>B</div>` → `A\n\nB`; spacer `<div><br></div>` lines
    collapse; a document with `<pre>` is untouched; NBSP kept in `**Salary:**\u00A0$100k`.
- [x] T06 — Previous behaviour reachable (owner rule)
  - **Files:** `packages/common/src/converters/description-converter.ts`
  - **Acceptance:** `{ edgeSafe: false }` and `EVER_JOBS_MARKDOWN_EDGE_SAFE=false|0|no|off` return
    the previous output byte for byte; a per-call option wins over the env switch.
- [x] T07 — Regression and type-check
  - **Acceptance:** spec 38/38; calling-plugin unit suites (75 spec files) plus `packages/common`:
    98 suites, 2654 tests, all green with the fix; `tsc -p tsconfig.typecheck.json` clean.
- [x] T08 — Linear-time padding handling
  - **Files:** `packages/common/src/converters/description-converter.ts`,
    `packages/common/__tests__/description-converter.spec.ts`
  - **Acceptance:** no unanchored `[...]*$` or `[ \t]+\n` regex; `wrapInlineEmphasis` on a
    200,000-character NBSP run returns well under 1 s (the regex it replaced takes 48 s on the same
    input); edge-safe conversion costs the same as the stock converter on long `&nbsp;` runs.
- [x] T09 — Spec, plan and tasks for Spec 1698.

## Notes

- Follow-ups Q-1 to Q-4 are in `spec.md` §9 for `docs/questions.md`.
