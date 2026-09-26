# Plan: 5149

| Field | Value |
| ----- | ----- |
| Spec ID | 5149 |
| Slug | source-company-zennoastronautics |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Approach

JSON-API company plugin (same single-fetch shape as
`source-company-power_us`, with a portable-text description composer):

1. Scaffold `packages/plugins/source-company-zennoastronautics/`
   (package.json, tsconfig, src/{index,module,service,constants,types},
   __tests__).
2. `zennoastronautics.service.ts` — `@SourcePlugin({site:
   Site.ZENNOASTRONAUTICS, name: 'Zenno Astronautics', category:
   'company', companyDomains: ['zennoastronautics.com']})`;
   `createHttpClient` GET of the Sanity query URL with the encoded GROQ.
3. Portable-text → plain-text composer in the service: spans joined per
   block, `markDefs` link refs appended as `text (href)`, `listItem`
   blocks bulleted, empty blocks dropped, blocks joined on `\n\n`.
4. Register in the four places: `site.enum.ts` (Phase 1702,
   `ZENNOASTRONAUTICS = 'zennoastronautics'`),
   `packages/plugins/index.ts`, `tsconfig.base.json` paths,
   `jest.config.js` moduleNameMapper.
5. Tests + fixture; docs (`docs/index.md` row, `docs/log.md` entry);
   conventional commit; PR to `develop`.

## Risks

- Sanity dataset/project id could rotate on a site rebuild — the plugin
  reports a classified fetch error rather than a silent empty board if
  the endpoint dies; an empty `result` still maps to `empty`.
- Portable-text `markDefs`/`children` shapes are stable Sanity
  primitives; unknown span marks degrade to the plain text.
- `isActive` is a per-job CMS flag — the query filters to active jobs
  only, so unpublished drafts never leak.

## Phases

- Phase 1 (this change): plugin + tests + docs.
