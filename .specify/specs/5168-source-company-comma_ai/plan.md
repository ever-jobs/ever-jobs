# Plan — Spec 5168 `source-company-comma_ai`

## Phases

1. **Scaffold** the plugin package (`package.json`, `tsconfig.json`,
   `src/index.ts`, module, service, constants, types) mirroring
   `source-company-labs_actor`.
2. **Implement `fetchJobs`**: fetch `/jobs` HTML → collect
   `/_app/immutable/nodes/*.js` URLs → fetch each (cap ~5) until one
   matches the jobs-array anchor → parse.
3. **Implement `toJobPost`**: slug from title, department/location/
   description/applyUrl mapping per spec.
4. **Register** in the four places: `Site.COMMA_AI` in `site.enum.ts`,
   `ALL_SOURCE_MODULES` in `packages/plugins/index.ts`, `tsconfig.base.json`
   path alias, `jest.config.js` `moduleNameMapper`.
5. **Tests + docs** + PR.

## Key technical choices

- **Parse, don't eval.** The jobs array is a JS literal inside a minified
  chunk. Reuse the labs_actor approach: `balancedSlice` (bracket-aware,
  string-skipping) → `splitTopLevel` → per-object field extraction.
- **Backtick strings.** Unlike labs_actor's scalar fields, comma.ai's
  `description` is a template literal — the string scanner must also treat
  `` ` `` as a quote character (its content contains `'`/`"` but no
  backticks; `${}` does not appear in the data).
- **Chunk discovery.** The page embeds the node-chunk URLs directly in
  `import("…")` calls inside its inline boot script plus modulepreload
  links — a regex over the HTML is sufficient; no SvelteKit manifest needed.

## Risks

- **Bundle hash rotation** — handled: node URLs resolved per fetch.
- **Anchor regex too loose** — `=[{title:"` could match a non-jobs array;
  mitigated by requiring `qualifications:` inside candidate chunks and by
  returning on the first chunk that yields ≥1 parseable job.
- **Slug drift** — if comma.ai renames a title, anchor URLs change; stable
  `id`/`atsId` still key on the derived slug (same rule as the page's own
  `article` ids).
