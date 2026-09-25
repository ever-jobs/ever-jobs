import { createHash } from 'crypto';
import { JobPostDto, JobType } from '@ever-jobs/models';
import { canonicalCountryName, normalizeLocation } from '@ever-jobs/common';

import { UnionFind } from './union-find';

/**
 * Merge gate — Spec 1724.
 *
 * The strategies propose merges (stage 1: identical `canonicalJobId`; stage 2:
 * near-identical description text). Neither looks at *where* a posting is or
 * *what kind of engagement* it is, so a firm that posts the same role per
 * office — one description, one posting per city, sometimes one per program —
 * had every office folded into one record (a live list-mode crawl of one ATS
 * board: 30 postings in, 20 out; a New York "Full-Time: New Grad" posting was
 * dropped into a Hong Kong "Summer Internship").
 *
 * The gate vetoes a proposed merge unless the two groups are compatible:
 *
 *  - **Location.** Every posting is reduced to a set of normalised sites
 *    (city / state / country, or `remote`). Two site sets are compatible when
 *    either is empty (the posting names no place) or one covers the other
 *    (every site of the smaller matches a site of the larger — a job board
 *    that shows only the first office of a multi-office posting still merges
 *    with it). Two sites match when no field both name disagrees, so
 *    `New York, NY` matches `New York, NY, United States`, and `Hong Kong`
 *    never matches `Singapore`.
 *  - **Employment type.** `jobType[]` and the free-text `employmentType` map to
 *    coarse classes (`fulltime`, `parttime`, `internship`, `contract`,
 *    `temporary`, `volunteer`, `apprenticeship`). Two postings conflict when
 *    both have classes and the sets are disjoint (a "Summer Internship" is
 *    never the "Full-Time: New Grad" posting), or when they come from the SAME
 *    source and carry different `employmentType` labels (one ATS vocabulary:
 *    "Full-Time: New Grad" and "Full-Time: Experienced" are two postings).
 *    Labels from different sources are only compared through their classes —
 *    vocabularies differ across boards.
 *
 * Compatibility is checked against EVERY member already in each group, not
 * against a merged summary, so a chain cannot bridge two incompatible
 * postings (A ~ B and B ~ C never puts A and C together unless A ~ C).
 */

/** One place a posting is (or may be) worked from, normalised for comparison. */
export interface SiteDescriptor {
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
  readonly remote?: true;
}

/** What the gate knows about one posting. Built once per input. */
export interface MergeProfile {
  /** Normalised sites; empty when the posting names no usable place. */
  readonly sites: ReadonlyArray<SiteDescriptor>;
  /** Stable signature of {@link sites} (sorted); `''` when empty. */
  readonly sitesSig: string;
  /** Coarse employment classes, sorted; empty when unknown. */
  readonly classes: ReadonlyArray<string>;
  /** `classes.join('+')`; `''` when empty. */
  readonly classesSig: string;
  /** Source site (`JobPostDto.site`); `''` when unknown. */
  readonly source: string;
  /** Normalised `employmentType` label; `''` when absent. */
  readonly label: string;
}

const REMOTE = 'remote';

function isRemoteToken(value: string | null | undefined): boolean {
  return Boolean(value) && normalizeLocation(value) === REMOTE;
}

type LocationLike = {
  city?: string | null;
  state?: string | null;
  country?: unknown;
  name?: string | null;
  text?: string | null;
};

function descriptorOf(loc: LocationLike | null | undefined): SiteDescriptor | null {
  if (!loc) return null;
  if (isRemoteToken(loc.city)) return { remote: true };
  const city = loc.city ? normalizeLocation(loc.city) : '';
  const state = loc.state ? normalizeLocation(loc.state) : '';
  const rawCountry = loc.country == null || loc.country === '' ? '' : String(loc.country);
  const country = rawCountry ? normalizeLocation(canonicalCountryName(rawCountry) ?? rawCountry) : '';
  if (!city && !state && !country) {
    return isRemoteToken(loc.name) || isRemoteToken(loc.text) ? { remote: true } : null;
  }
  return {
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(country ? { country } : {}),
  };
}

function descriptorSig(d: SiteDescriptor): string {
  return d.remote ? REMOTE : `${d.city ?? ''}|${d.state ?? ''}|${d.country ?? ''}`;
}

/**
 * The posting's sites. Mirrors the canonical key's reading of a job
 * (`@ever-jobs/common` `canonical-key.ts`): per-site `locations[]` when they
 * yield anything, else the flat `location`; a remote posting with no concrete
 * site (no city/state) is the single site `remote`.
 */
export function sitesOf(job: JobPostDto): SiteDescriptor[] {
  let list = (job.locations ?? []).map(descriptorOf).filter((d): d is SiteDescriptor => d !== null);
  if (list.length === 0) {
    const flat = descriptorOf(job.location as LocationLike | null | undefined);
    if (flat) list = [flat];
  }
  const concrete = list.some((d) => Boolean(d.city || d.state));
  if (!concrete) {
    const remote =
      job.isRemote === true ||
      list.some((d) => d.remote) ||
      (job.locations ?? []).some((l) => isRemoteToken(l?.name) || isRemoteToken(l?.text));
    if (remote) return [{ remote: true }];
  }
  const bySig = new Map<string, SiteDescriptor>();
  for (const d of list) bySig.set(descriptorSig(d), d);
  return [...bySig.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, d]) => d);
}

/** Two sites match when no field both of them name disagrees; `remote` only matches `remote`. */
export function sitesMatch(a: SiteDescriptor, b: SiteDescriptor): boolean {
  if (a.remote || b.remote) return Boolean(a.remote && b.remote);
  if (a.city && b.city && a.city !== b.city) return false;
  if (a.state && b.state && a.state !== b.state) return false;
  if (a.country && b.country && a.country !== b.country) return false;
  return true;
}

/** Every site of `small` matches some site of `big`. */
function covers(big: ReadonlyArray<SiteDescriptor>, small: ReadonlyArray<SiteDescriptor>): boolean {
  return small.every((s) => big.some((b) => sitesMatch(b, s)));
}

/** Site sets are compatible when either is empty or one covers the other. */
export function siteSetsCompatible(
  a: ReadonlyArray<SiteDescriptor>,
  b: ReadonlyArray<SiteDescriptor>,
): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return covers(a, b) || covers(b, a);
}

const JOB_TYPE_CLASS: Partial<Record<string, string>> = {
  [JobType.FULL_TIME]: 'fulltime',
  [JobType.PART_TIME]: 'parttime',
  [JobType.CONTRACT]: 'contract',
  [JobType.TEMPORARY]: 'temporary',
  [JobType.INTERNSHIP]: 'internship',
  [JobType.VOLUNTEER]: 'volunteer',
};

/** Keyword → class, matched on the normalised label (lower case, words separated by one space). */
const LABEL_CLASSES: ReadonlyArray<readonly [string, RegExp]> = [
  ['internship', /\b(?:intern|interns|internship|internships|co op|coop|praktikum|werkstudent)\b/],
  ['fulltime', /\b(?:full time|fulltime|permanent|regular|vollzeit)\b/],
  ['parttime', /\b(?:part time|parttime|teilzeit)\b/],
  ['contract', /\b(?:contract|contractor|freelance|freelancer)\b/],
  ['temporary', /\b(?:temporary|temp|seasonal|fixed term)\b/],
  ['volunteer', /\bvolunteer\b/],
  ['apprenticeship', /\b(?:apprentice|apprenticeship)\b/],
];

/** Lower-cased, NFKC, every run of non-letters/digits collapsed to one space. */
export function normalizeEmploymentLabel(label: string | null | undefined): string {
  if (!label) return '';
  return label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Coarse employment classes of a posting, from `jobType[]` and the `employmentType` label. */
export function employmentClassesOf(job: Pick<JobPostDto, 'jobType' | 'employmentType'>): string[] {
  const classes = new Set<string>();
  for (const t of job.jobType ?? []) {
    const c = JOB_TYPE_CLASS[String(t)];
    if (c) classes.add(c);
  }
  const label = normalizeEmploymentLabel(job.employmentType);
  if (label) {
    for (const [c, re] of LABEL_CLASSES) if (re.test(label)) classes.add(c);
  }
  return [...classes].sort();
}

/** Build the gate's view of one posting. */
export function mergeProfileOf(job: JobPostDto): MergeProfile {
  const sites = sitesOf(job);
  const classes = employmentClassesOf(job);
  return {
    sites,
    sitesSig: sites.map(descriptorSig).join(';'),
    classes,
    classesSig: classes.join('+'),
    source: job.site ? String(job.site) : '',
    label: normalizeEmploymentLabel(job.employmentType),
  };
}

/** Two single postings may be merged (the pairwise rule; groups apply it member by member). */
export function profilesCompatible(a: MergeProfile, b: MergeProfile): boolean {
  if (!siteSetsCompatible(a.sites, b.sites)) return false;
  if (a.classes.length > 0 && b.classes.length > 0 && !a.classes.some((c) => b.classes.includes(c))) {
    return false;
  }
  if (a.source && a.source === b.source && a.label && b.label && a.label !== b.label) return false;
  return true;
}

/** The distinct profiles of one group's members — pairwise compatible by construction. */
interface Group {
  readonly profiles: MergeProfile[];
  readonly keys: Set<string>;
}

function profileKey(p: MergeProfile): string {
  return `${p.sitesSig}\u0000${p.classesSig}\u0000${p.source}\u0000${p.label}`;
}

/**
 * Upper bound on the sub-groups one proposed cluster is split into that a new
 * member is tried against. A member that matches none of them starts its own
 * group, so the cap can only keep postings apart, never merge wrongly; it
 * bounds the work on a pathological cluster (hundreds of postings sharing one
 * boilerplate description, each at a different office).
 */
export const MAX_SUBGROUPS_SCANNED = 256;

/**
 * Applies the gate while the service unions strategy partitions. Holds one
 * {@link Group} per Union-Find root.
 *
 * Profiles are built lazily: only postings a strategy proposes to merge are
 * ever looked at, and in a list-mode batch most postings are singletons.
 */
export class MergeGate {
  /** Members a strategy proposed to merge that the gate kept apart from every sub-group. */
  refused = 0;
  private readonly groups: (Group | undefined)[];
  private readonly profiles: (MergeProfile | undefined)[];

  /** @param jobs the prepared jobs, by prepared position */
  constructor(private readonly jobs: ReadonlyArray<JobPostDto>) {
    this.groups = new Array(jobs.length);
    this.profiles = new Array(jobs.length);
  }

  /** The gate's view of the posting at prepared position `pos`. */
  profile(pos: number): MergeProfile {
    let p = this.profiles[pos];
    if (!p) {
      p = mergeProfileOf(this.jobs[pos]!);
      this.profiles[pos] = p;
    }
    return p;
  }

  /**
   * Place `pos` into the first of `heads` (sub-groups of the proposed cluster,
   * in cluster order) it is already joined to or may join; otherwise it becomes
   * a new head. Returns `true` when it joined an existing head.
   */
  place(uf: UnionFind, heads: number[], pos: number): boolean {
    const scan = Math.min(heads.length, MAX_SUBGROUPS_SCANNED);
    let refusedHere = false;
    for (let h = 0; h < scan; h++) {
      const head = heads[h]!;
      if (uf.find(head) === uf.find(pos)) return true;
      if (this.tryUnion(uf, head, pos)) return true;
      refusedHere = true;
    }
    if (refusedHere) this.refused++;
    heads.push(pos);
    return false;
  }

  /** Union the groups of `a` and `b` when every pair of their members is compatible. */
  tryUnion(uf: UnionFind, a: number, b: number): boolean {
    const ra = uf.find(a);
    const rb = uf.find(b);
    if (ra === rb) return true;
    const ga = this.groupOf(ra);
    const gb = this.groupOf(rb);
    for (const pa of ga.profiles) {
      for (const pb of gb.profiles) {
        if (!profilesCompatible(pa, pb)) return false;
      }
    }
    uf.union(ra, rb);
    const root = uf.find(ra);
    // Fold the smaller group into the larger one.
    const [big, small] = ga.profiles.length >= gb.profiles.length ? [ga, gb] : [gb, ga];
    for (const p of small.profiles) {
      const key = profileKey(p);
      if (!big.keys.has(key)) {
        big.keys.add(key);
        big.profiles.push(p);
      }
    }
    this.groups[ra] = undefined;
    this.groups[rb] = undefined;
    this.groups[root] = big;
    return true;
  }

  private groupOf(root: number): Group {
    let group = this.groups[root];
    if (!group) {
      const p = this.profile(root);
      group = { profiles: [p], keys: new Set([profileKey(p)]) };
      this.groups[root] = group;
    }
    return group;
  }
}

/**
 * What tells a cluster apart from another cluster whose head has the same
 * canonical key (they were kept apart by the gate): the head's employment
 * label, else its classes, else its sites.
 */
export function clusterDiscriminator(profile: MergeProfile): string {
  return profile.label || profile.classesSig || profile.sitesSig;
}

/**
 * `canonicalJobId` of a cluster that shares its head's canonical key with
 * another cluster of the same batch: sha-256 of `<canonicalKey>|<discriminator>`.
 * A canonical key has exactly two `|`, so the input can never equal another
 * posting's key.
 */
export function discriminatedCanonicalJobId(canonicalKey: string, discriminator: string): string {
  return createHash('sha256').update(`${canonicalKey}|${discriminator}`, 'utf8').digest('hex');
}
