# Spec: 1724 — Dedup merge gate: keep one posting per office and per program

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1724                                     |
| Slug           | dedup-merge-gate                         |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 003, 722, 5123, 1689, 1720, 1721         |

## 1. Problem Statement

A live list-mode crawl of one company board (Jane Street, Greenhouse, `resultsWanted: 30`)
returned 30 postings with `dedup=false` and **20** with the default `dedup=true`. The default
engine (`dedup-hybrid`, Spec 003) has two stages, and neither looks at *where* a posting is or at
*what kind of engagement* it is:

- **Stage 1 (hash)** merges every posting with the same `canonicalJobId`
  (company + title + location). Two postings of the same title in the same city are one
  cluster even when one is a "Summer Internship" and the other a "Full-Time: New Grad" program.
- **Stage 2 (MinHash)** merges postings whose descriptions are near-identical. A firm that posts
  one role per office uses one description for every office, so New York, London, Hong Kong and
  Singapore collapse into one record.

Union-Find then chains the two: the New York "Full-Time: New Grad" posting (hash-merged with the
New York internship) was folded into the Hong Kong "Summer Internship" (MinHash-merged with the
New York internship) and dropped from the response. A consumer that builds a corpus from list
mode loses a third of the board without any signal.

## 2. Goals

- Two postings are only merged when their **locations are compatible** and their **employment
  types do not conflict** — whichever stage proposed the merge.
- When postings are merged, the kept job carries the **union of their locations**.
- Distinct postings never share a cluster id, and the API never gives them one `dedupKey` on the
  default `dedup=true` path.
- Every merge that was correct before (the same posting on a board and on the ATS, reposts,
  remote variants, a multi-office posting and a board listing of one of its offices) still
  happens.

## 3. Non-Goals

- Changing what the strategies propose (thresholds, shingles, key normalisation).
- Telling apart two different roles with identical boilerplate descriptions at the same place and
  employment type (the gate only vetoes on location and employment type).
- Career-level distinctions beyond the employment label (Spec 1730 classifies levels).

## 4. Functional Requirements

| ID   | Requirement | Priority |
| ---- | ----------- | -------- |
| FR-1 | Every merge a strategy proposes is checked by a merge gate before it is applied. A proposed cluster the gate refuses is split, in input order, into sub-groups: each member joins the first earlier sub-group it is compatible with, else starts its own. | must |
| FR-2 | **Location.** Each posting is reduced to a set of normalised sites — per-site `locations[]` when they yield any, else the flat `location`; each site is city / state / country (`normalizeLocation`, countries through `canonicalCountryName`), or `remote`. A remote posting with no concrete site (no city/state) is the single site `remote`, exactly as the canonical key's remote bucket (Spec 1689). Two sites match when no field both name disagrees (`remote` only matches `remote`). Two site sets are compatible when either is empty, or every site of one matches a site of the other (one covers the other). | must |
| FR-3 | **Employment type.** `jobType[]` and the free-text `employmentType` map to coarse classes (`fulltime`, `parttime`, `internship`, `contract`, `temporary`, `volunteer`, `apprenticeship`). Two postings conflict when both have classes and the sets are disjoint, or when both come from the same source (`site`) and carry different normalised `employmentType` labels. Labels of different sources are compared only through their classes. | must |
| FR-4 | Compatibility is checked between every pair of distinct member profiles of the two groups being joined — never against a merged summary — so no chain can bridge two incompatible postings. | must |
| FR-5 | Cluster ids stay unique per batch. A cluster's id is its head's `canonicalJobId`, unless another cluster's head has the same canonical key (the gate split them); then every such cluster gets `sha256(<canonicalKey>|<discriminator>)` — the head's employment label, else its classes, else its sites — plus an ordinal while it still collides. | must |
| FR-6 | The aggregator's kept job (the first raw job of each cluster, as before) carries the cluster's `locations[]` union (the engine's `CanonicalJob.locations`, head first) when that adds a site; such a job is returned as a shallow copy, never by mutating the input (it may be the cached fan-out). | must |
| FR-7 | `dedupKey` on the `dedup=true` path: the kept job's own per-job key computed before the union (= its cluster id, Spec 1721 FR-10); when two kept jobs would share that key, each carries its cluster id instead. `dedup=false` is unchanged: per-job keys, so two postings whose title, company and location coincide still share one there. | must |
| FR-8 | No existing merge that FR-2/FR-3 allow changes. | must |

## 5. Non-Functional Requirements

| ID    | Requirement | Target |
| ----- | ----------- | ------ |
| NFR-1 | Cost | profiles are built lazily, only for postings a strategy proposes to merge; the dedup perf gates (Spec 722) stay green |
| NFR-2 | Event loop | the gated union loop yields on the same budget as the rest of the pass |
| NFR-3 | Bounded work | a member is tried against at most 256 sub-groups of one proposed cluster (`MAX_SUBGROUPS_SCANNED`); past that it starts its own group (keeps postings apart, never merges wrongly) |

## 6. Contracts

```ts
// packages/plugins/dedup-hybrid/src/merge-gate.ts
export interface SiteDescriptor { city?: string; state?: string; country?: string; remote?: true }
export interface MergeProfile { sites; sitesSig; classes; classesSig; source; label }
export function sitesOf(job: JobPostDto): SiteDescriptor[];
export function siteSetsCompatible(a, b): boolean;
export function employmentClassesOf(job: Pick<JobPostDto, 'jobType' | 'employmentType'>): string[];
export function mergeProfileOf(job: JobPostDto): MergeProfile;
export function profilesCompatible(a: MergeProfile, b: MergeProfile): boolean;
export class MergeGate { place(uf, heads, pos): boolean; tryUnion(uf, a, b): boolean; profile(pos): MergeProfile; refused: number }
export function discriminatedCanonicalJobId(canonicalKey: string, discriminator: string): string;
```

`IDedupEngine`, `DedupResult` and `CanonicalJob` are unchanged.

## 7. Test Plan

- `dedup-merge-gate.spec.ts` (dedup-hybrid): the captured Jane Street crawl (30 postings,
  descriptions encoded token-for-token so every shingle Jaccard is preserved) stays 30; a control
  unions the strategies' raw proposals and reproduces the live 30 → 20, including the New York
  new-grad / Hong Kong internship chain; the two New York SOC postings (same key) get distinct,
  deterministic ids, neither the shared plain id. Location rule: same city across sources merges
  (control); two cities do not; no location merges and the canonical keeps the union; a
  multi-office posting covers a board listing of one office; a location-less posting cannot
  bridge two cities; remote only with remote. Employment rule: internship vs full-time (same key)
  kept apart; two labels of one source kept apart; different sources whose classes agree merge;
  no employment information merges; `jobType[]` is read. Pure helpers.
- `jobs.aggregator.merge-gate.spec.ts` (api): one job per office and program, keys = engine
  assignments and all distinct; `dedup=false` still shares the per-job key; the kept job carries
  the union as a copy with its pre-union key and the input untouched; a merge that adds no site
  returns the raw job.
- Mutation checks: disabling the gate fails 9 engine tests; dropping the location rule 6; the
  class rule 1; the same-source label rule 1; the id disambiguation 3; dropping the aggregator
  union 1, the key override 1, the pre-keyed skip 2.
- All existing `dedup-hybrid` suites (service, hash, MinHash, perf, event loop) pass unchanged.

## 8. Open Questions

None new. The judgement calls are recorded as decisions below.

## 9. Decisions

- D-01 — **"Compatible" is covers-or-empty, not equal-or-empty.** The literal rule ("same
  normalised location, or one side has none") would stop a job board that shows only the first
  office of a multi-office ATS posting from merging with it, and would break Spec 5123's
  "MinHash-welded cluster with differing site sets" case. Covers-or-empty is the same rule for
  single-site postings (the overwhelming majority) and keeps those merges.
- D-02 — **Sites match on shared fields.** `New York, NY` (board) and `New York, NY, United
  States` (ATS) have different canonical-key strings but are the same place; comparing only the
  fields both name keeps them mergeable, while any disagreeing field (city, state or country)
  refuses.
- D-03 — **Same-source labels are compared verbatim; cross-source only by class.** One ATS uses
  one vocabulary, so "Full-Time: New Grad" and "Full-Time: Experienced" from one board are two
  programs. Across boards the labels differ for the same posting ("Full-time" vs "Full-Time:
  Experienced"), so only the coarse classes can conflict.
- D-04 — **Every colliding cluster gets a discriminated id**, rather than the first keeping the
  plain one. Which cluster comes first follows the output order (site, newest first), so "first
  keeps the plain id" would hand an existing posting's id to a newer one; a symmetric rule never
  re-assigns a posting's id to a different posting.
- D-05 — **`dedupKey` on `dedup=false` is unchanged.** Without the engine nothing knows the two
  postings conflict; making the per-job key read employment type would change every key that has
  an employment type and split cross-source matches whose boards disagree on it. Consumers that
  need the distinction use the default `dedup=true`.

## 10. References

- `packages/plugins/dedup-hybrid/src/merge-gate.ts`, `dedup-hybrid.service.ts`
- `apps/api/src/jobs/jobs.aggregator.ts`
