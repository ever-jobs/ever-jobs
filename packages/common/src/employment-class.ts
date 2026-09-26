import { createHash } from 'crypto';
import { JobPostDto, JobType } from '@ever-jobs/models';
import { canonicalKey, canonicalKeyInputForJob, dedupKeyForJob, type DedupKeyJobInput } from './canonical-key';

/**
 * Coarse employment classes (Spec 1724), shared by the dedup engine's merge
 * gate and the stable cluster key below.
 */
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

/**
 * The employment scope a posting's cluster key carries (Spec 1724 review):
 * `''` for the default engagement — full-time, or no employment information —
 * otherwise its classes joined with `+` (e.g. `internship`, `contract`).
 *
 * It depends only on the posting's own fields, never on what else is in the
 * batch, so a posting keeps one key across runs.
 */
export function employmentScopeOf(classes: ReadonlyArray<string>): string {
  if (classes.length === 0 || (classes.length === 1 && classes[0] === 'fulltime')) return '';
  return classes.join('+');
}

/**
 * sha-256 of `<canonicalKey>|<discriminator>`: the id of a posting that shares
 * its canonical key with a posting of another kind. A canonical key has
 * exactly two `|`, so the input can never equal another posting's plain key.
 */
export function discriminatedCanonicalJobId(key: string, discriminator: string): string {
  return createHash('sha256').update(`${key}|${discriminator}`, 'utf8').digest('hex');
}

/** The job fields {@link clusterKeyForJob} reads. */
export type ClusterKeyJobInput = DedupKeyJobInput & Pick<JobPostDto, 'jobType' | 'employmentType'>;

/**
 * Stable key of the cluster a deduplicated posting heads (Spec 1724 review):
 * {@link dedupKeyForJob} for the default engagement, else
 * `sha256(<canonicalKey>|<employment scope>)`. An internship and a full-time
 * posting with the same company, title and location therefore never share a
 * key — in every batch, not only in a batch that holds both — so a stored row
 * keeps its id from run to run. `undefined` exactly when {@link dedupKeyForJob}
 * is. `plain`, when the caller already has it, is the job's
 * {@link dedupKeyForJob} value (saves a hash).
 */
export function clusterKeyForJob(
  job: ClusterKeyJobInput,
  plain: string | undefined = dedupKeyForJob(job),
): string | undefined {
  if (plain === undefined) return undefined;
  const scope = employmentScopeOf(employmentClassesOf(job));
  return scope ? discriminatedCanonicalJobId(canonicalKey(canonicalKeyInputForJob(job)), scope) : plain;
}
