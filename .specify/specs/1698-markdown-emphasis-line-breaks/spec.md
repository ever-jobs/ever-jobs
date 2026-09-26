# Spec: 1698 — Markdown emphasis and line-break fidelity

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1698                                     |
| Slug           | markdown-emphasis-line-breaks            |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | (none)                                   |

## 1. Problem Statement

`markdownConverter()` in `packages/common/src/converters/description-converter.ts` produces the
description for `descriptionFormat = MARKDOWN`, the default in `ScraperInputDto`, for 287 source
plugins. It was a stock `TurndownService` (turndown 7.2.4) with no rules of its own.

When a `<br>` sits at the start or end of a `<strong>`/`<b>`/`<em>`/`<i>` element, turndown leaves
the hard break (`"  \n"`) inside the delimiters: it only moves *text* whitespace outside an inline
element, and a `<br>` is not text. CommonMark refuses a delimiter run that is followed (opening) or
preceded (closing) by whitespace, and emphasis cannot cross a blank line, so the reader sees literal
`**` / `_`. The shape is common in ATS and company-page HTML: a bold label ending in `<br><br>`
followed by a list.

| HTML | before | after |
| ---- | ------ | ----- |
| `<strong>OUR HIRING PROCESS:<br/><br/></strong><ul><li>We will review</li></ul>` | `**OUR HIRING PROCESS:  \n  \n**\n\n*   We will review` | `**OUR HIRING PROCESS:**\n\n*   We will review` |
| `<strong>Title<br></strong>text` | `**Title  \n**text` | `**Title**  \ntext` |
| `text<b><br>Title</b>` | `text**  \nTitle**` | `text  \n**Title**` |
| `<strong>A<br><br>B</strong>` | `**A  \n  \nB**` | `**A**\n\n**B**` |
| `<b><p>First</p><p>Second</p></b>` | `**\n\nFirst\n\nSecond\n\n**` | `**First**\n\n**Second**` |
| `<strong><ul><li>x</li></ul></strong>` | `**\n\n*   x\n\n**` | `*   x` |
| `<p>a<strong><br/></strong>b</p>` | `ab` (break lost) | `a  \nb` |
| `<h2>Title<br></h2>` | `Title  \n\n--------` (paragraph + rule) | `Title\n-----` |
| `<h3>Title<br>Sub</h3>` | `### Title  \nSub` (`Sub` falls out) | `### Title Sub` |
| `<ol><li><b>Step one<br><br></b>Do it</li></ol>` | `1.  **Step one  \n      \n    **Do it` | `1.  **Step one**\n\n    Do it` |
| `<strong>Inquiries<br/>&#x200D;<br/></strong>Contact us` | `**Inquiries  \n\u200D  \n**Contact us` | `**Inquiries**\n\nContact us` |
| `<div>A<br><br><br><br>B</div>` | `A  \n  \n  \n  \nB` | `A\n\nB` |

Evidence: four committed plugin fixtures contain the shape (for example
`source-company-avalanchefusion/__tests__/fixtures/mechanical-engineer.html` has
`<p><strong><br/>About …</strong></p>`, and `source-company-hyl_io` has the zero-width-joiner
filler line). A two-request probe of two public ATS job APIs with an honest user agent found the
exact defect in 1 of 164 postings on one and whitespace-only filler lines in 60 of 60 on the other;
both disappear with this change.

## 2. Goals

- Emphasis delimiters always sit directly on the text they wrap.
- A heading stays one Markdown line.
- Whitespace-only noise from `<br>` runs and spacer `<div><br></div>` lines collapses, without
  changing how the Markdown renders.
- The previous output stays reachable per call and process-wide.

## 3. Non-Goals

- No new dependency, no turndown fork, no GFM plugin.
- No change to `plainConverter`, `removeAttributes`, or to which plugins call `markdownConverter`.
- No change to link rendering (see Q-3).

## 4. User / Caller Stories

> As a **consumer of the MARKDOWN description**, I want **bold labels and headings to render as
> bold labels and headings**, so that **I never see stray `**` or `_` in a job description**.

> As an **operator**, I want **one switch back to the previous output**, so that **I can compare or
> roll back without a deploy**.

## 5. Functional Requirements

| ID   | Requirement | Priority |
| ---- | ----------- | -------- |
| FR-1 | Leading/trailing whitespace, hard breaks and zero-width characters inside `strong`/`b`/`em`/`i` are emitted outside the delimiters; a single edge break stays a hard break. | must |
| FR-2 | Emphasis spanning a blank line (including a line holding only zero-width characters) is wrapped once per paragraph. | must |
| FR-3 | An emphasis element holding only a break keeps the break and emits no delimiters. | must |
| FR-4 | An emphasis element containing `ul, ol, table, pre, blockquote, h1–h6, hr` emits its content without delimiters. | must |
| FR-5 | Headings drop edge breaks and fold interior line breaks (and blank lines) into one space; setext/ATX choice and `headingStyle` are unchanged. | must |
| FR-6 | Whitespace-only / zero-width-only lines become empty, hard-break spaces before a blank line are dropped, and 3+ newlines collapse to one blank line — unless the source HTML has `<pre`. | must |
| FR-7 | A bold label followed by a list keeps its blank line (already correct; locked in by a test). | must |
| FR-8 | `markdownConverter(html, { edgeSafe: false })` or `EVER_JOBS_MARKDOWN_EDGE_SAFE=false` returns the previous output byte for byte. | must |

## 6. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Cost per emphasis node | one `split` + two anchored regexes |
| NFR-2 | Cost per document | three global regexes (skipped with `<pre`) |
| NFR-3 | Network | none — pure function |

## 7. Contracts

### 7.1 API / Interface

```ts
export const MARKDOWN_EDGE_SAFE_ENV = 'EVER_JOBS_MARKDOWN_EDGE_SAFE';

export interface MarkdownConverterOptions {
  /** true = Spec 1698 rules (default); false = previous output. Omitted: the env switch decides. */
  edgeSafe?: boolean;
}

export function markdownConverter(
  descriptionHtml: string | null,
  options?: MarkdownConverterOptions,
): string | null;

/** Wrap converted inline Markdown in `delimiter`, keeping edge padding outside it. */
export function wrapInlineEmphasis(content: string, delimiter: string): string;
```

All three are exported from `description-converter.ts`, which the converters barrel re-exports.
The env switch accepts `false` / `0` / `no` / `off` (case-insensitive, trimmed); anything else,
or unset, keeps the fix on. A per-call `edgeSafe` wins over the env switch.

### 7.2 Errors

None. `null` / `''` input still returns `null`.

## 8. Test Plan

- Unit: `packages/common/__tests__/description-converter.spec.ts` — 38 cases in 5 blocks
  (emphasis edges, headings, whitespace tidy, previous behaviour reachable, `wrapInlineEmphasis`).
  Synthetic inputs only. Red against the previous converter for the right reasons (the lock-in,
  already-correct and previous-output cases pass there; every fix case fails). One case pins
  linear time on a 200,000-character padding run; the unanchored trailing-padding regex it
  replaced takes 48 s on that input.
- Regression: every unit suite of the plugins that call `markdownConverter` (75 spec files),
  run with the fix and with `EVER_JOBS_MARKDOWN_EDGE_SAFE=false`, plus the `packages/common`
  suites: 98 suites, 2654 tests, all green with the fix.
- Integration / E2E / performance: not applicable (pure function).

## 9. Open Questions

Recorded for `docs/questions.md` (default — proceeding: leave as is):

- **Q-1** `source-ats-greenhouse` and `source-ats-lever` return plain text when MARKDOWN is
  requested. Should they call `markdownConverter`?
- **Q-2** The final `.trim()` strips the 4-space indent of an indented code block that opens the
  document (`<pre><code>…` first). Consider fenced code blocks or a newline-only trim.
- **Q-3** Link text can carry a trailing hard break (`<a><strong>Apply<br></strong></a>` →
  `[**Apply**  \n](url)`). It renders, but an `inlineLink` rule could trim it the same way.
- **Q-4** turndown itself is quadratic on long runs of `&nbsp;` and `<br>&nbsp;` (about 11 s for
  20,000 `<br>&nbsp;` pairs, 0.5 s for 20,000 `&nbsp;` in a `<b>`), with or without this spec.
  Consider a size cap or a pre-pass on description HTML before conversion.

## 10. Decisions

- **D-01 — Public turndown API only.** Three rules added with `addRule`, which places them ahead
  of the built-in `strong`, `emphasis` and `heading` rules. Every other rule and option stays
  turndown's default.
- **D-02 — Move padding, do not delete it.** A single edge break stays a hard break after the
  closing delimiter; only the tidy pass removes whitespace, and only where it cannot render.
- **D-03 — Drop delimiters around block content.** Printing literal `**` around a list is worse
  than losing the bold.
- **D-04 — A zero-width-only line is a paragraph break for emphasis.** The tidy pass empties such
  lines, so emphasis must already be closed before one (`<strong>A<br>&#x200B;<br>B</strong>` →
  `**A**\n\n**B**`). A line holding an NBSP is not blank in CommonMark and is left alone.
- **D-05 — Heading breaks fold to one space**, including a blank line between two blocks inside
  the heading (`<h4><p>a</p><p>b</p></h4>` → `#### a b`), not one space per newline.
- **D-06 — `<pre>` disables the tidy pass** for the whole document: blank lines inside code are
  content.
- **D-07 — Previous behaviour stays reachable** (owner rule): `edgeSafe: false` or
  `EVER_JOBS_MARKDOWN_EDGE_SAFE=false` uses a stock `TurndownService` with no tidy, exactly as
  before. The env switch follows the `EVER_JOBS_HTTP_PIN_REDIRECTS` shape and is read per call.
- **D-08 — Delimiters come from turndown's options at replacement time**, like the built-in
  rules, rather than being captured when the service is built.
- **D-09 — Linear scans only.** Trailing padding is found by a backward character scan, headings
  are folded by splitting on newlines, and the tidy pass strips hard-break spaces line by line. An
  unanchored `[...]*$` or `[ \t]+\n` regex is quadratic on a long run that does not end the
  match, and description HTML is remote input. The new rules add no measurable cost on top of
  turndown (Q-4).

## 11. References

- `packages/common/src/converters/description-converter.ts`
- `packages/common/__tests__/description-converter.spec.ts`
- `node_modules/turndown/lib/turndown.cjs.js` — `rules.lineBreak`, `rules.strong`,
  `rules.emphasis`, `rules.heading`, `replacementForNode`
- CommonMark spec §6.2 (emphasis: left-/right-flanking delimiter runs), §4.9 (blank lines)
