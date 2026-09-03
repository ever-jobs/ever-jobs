# Spec: 5090 — Fix Pinpoint location / remote parsing

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Spec ID        | 5090                                                    |
| Slug           | source-ats-pinpoint-location-object                     |
| Status         | in progress                                             |
| Owner          | agent                                                   |
| Created        | 2026-09-02                                              |
| Last updated   | 2026-09-02                                              |
| Supersedes     | (none)                                                  |
| Related specs  | (none)                                                  |

## 1. Problem Statement

`source-ats-pinpoint` returns 0 jobs for live Pinpoint boards because the
`postings.json` response now carries `location` as an object (`{ name, city,
province, ... }`) and `workplace_type` as the remote/onsite/hybrid signal.
The plugin reads `attrs.location` as a string and calls `.toLowerCase()` on it
inside the `isRemote` check, which throws a `TypeError`. The outer `try/catch`
then returns an empty `JobResponseDto`.

## 2. Goals

- Parse `location` correctly whether it is a string or an object.
- Derive `isRemote` from `workplace_type` / `remote` / `location.name` without
  throwing.
- Add unit tests covering the object-location shape and the remote/onsite/hybrid
  cases.
- Leave the board URL (`https://${company}.pinpointhq.com/postings.json`) and
  other field mappings unchanged.

## 3. Non-Goals

- No new package or plugin registration.
- No headless/browser fallback.
- No general Pinpoint schema migration beyond `location` and `isRemote`.

## 4. Design

### 4.1 `location` normalization

After `attrs = listing.attributes ?? listing`:

- If `attrs.location` is a string, use it as the location text.
- If it is an object, prefer `name`, then `city`, then `province`.
- Trim whitespace from the chosen text.
- Construct `new LocationDto({ city: locationText, state: province })` when
  `province` is available.

### 4.2 `isRemote` derivation

Priority order:

1. `attrs.remote` boolean (if present).
2. `attrs.workplace_type === 'remote'`.
3. `locationText.toLowerCase().includes('remote')` (only when `locationText` is
   a string).
4. Default to `false`.

### 4.3 Other fields

- `title`, `url`, `id`, `description`, `company_name`, `employment_type` keep
  their existing mappings.
- `description` continues to be stripped of HTML tags.

## 5. Acceptance

- `PinpointService` unit test with a mocked `postings.json` fixture containing
  3 postings returns 3 `JobPostDto`s.
- Object `location` with `name` and `province` maps to
  `LocationDto({ city: 'Redondo Beach', state: 'California' })`.
- `workplace_type: 'remote'` sets `isRemote: true`; `onsite` sets `false`;
  a string location containing `'remote'` sets `true`.
- `tsc --noEmit` is clean for the package.
- New Jest suite under `packages/plugins/source-ats-pinpoint/__tests__/` passes.

## 6. Risks

- Pinpoint may later remove `workplace_type` or rename `location` fields; the
  fallback to string `location` and a safe default keeps the plugin from
  crashing.
