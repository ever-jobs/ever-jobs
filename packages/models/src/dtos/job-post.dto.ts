import { JobType } from '../enums/job-type.enum';
import { LocationDto } from './location.dto';
import { OfficeDto } from './office.dto';
import { CompensationDto } from './compensation.dto';
import type { CareerLevelVerdict } from '../interfaces/career-level-classifier.interface';

export class JobPostDto {
  id?: string | null;
  title!: string;
  companyName?: string | null;
  jobUrl!: string;
  jobUrlDirect?: string | null;
  location?: LocationDto | null;

  /** Per-site locations when the source carries them (e.g. an ATS `locations[]`
   *  array). `location` remains the merged single-site view for compatibility. */
  locations?: LocationDto[] | null;

  /** Company offices the source tags on the posting (e.g. Greenhouse
   *  `offices[]`). A catalog of company entities, not necessarily the role's
   *  sites — use `locations[]` for those. */
  offices?: OfficeDto[] | null;

  /** ISO-3166 alpha-2 country the ATS declared for the posting (e.g. "NL").
   *  Posting-level metadata — not the parsed country of `location`. */
  countryCode?: string | null;

  description?: string | null;
  companyUrl?: string | null;
  companyUrlDirect?: string | null;

  jobType?: JobType[] | null;
  compensation?: CompensationDto | null;
  datePosted?: Date | string | null;
  emails?: string[] | null;
  isRemote?: boolean | null;
  listingType?: string | null;

  // LinkedIn specific
  jobLevel?: string | null;

  // LinkedIn and Indeed specific
  companyIndustry?: string | null;

  // Indeed specific
  companyAddresses?: string | null;
  companyNumEmployees?: string | null;
  companyRevenue?: string | null;
  companyDescription?: string | null;
  companyLogo?: string | null;
  bannerPhotoUrl?: string | null;

  // LinkedIn only
  jobFunction?: string | null;

  // originally for Naukri; may be be used by others
  skills?: string[] | null;
  experienceRange?: string | null;
  companyRating?: number | null;
  companyReviewsCount?: number | null;
  vacancyCount?: number | null;
  workFromHomeType?: string | null;  // e.g. for Hybrid

  // Salary enrichment metadata (set during post-processing)
  salarySource?: string | null;

  // ATS-specific metadata
  department?: string | null;
  team?: string | null;
  atsId?: string | null;
  atsType?: string | null;
  employmentType?: string | null;
  applyUrl?: string | null;

  // Site identifier (filled in during aggregation)
  site?: string | null;

  /**
   * Stable cross-source identity of the posting (Spec 1721): sha-256 of the
   * normalised `company|title|location` triple — the same `canonicalJobId` the
   * dedup engine clusters on. The same posting seen via different sources or
   * on different runs gets the same key. Stamped on every returned job.
   */
  dedupKey?: string | null;

  // Corpus signals (Spec 740) — opt-in via ?liveness=true / ?legitimacy=true; absent by default.
  // Shapes mirror what the Hust frontend already consumes (forward-compatible).
  liveness?: {
    state: 'active' | 'expired' | 'uncertain';
    checkedAt?: string;
  } | null;
  legitimacy?: {
    state: 'verified' | 'likely' | 'uncertain';
    reasons?: string[];
  } | null;

  // Career level (Spec 1730, contract C7) — computed server-side after dedup by the bound
  // `ICareerLevelClassifier`; on by default, off with EVER_JOBS_CLASSIFY_CAREER_LEVEL=false.
  // Derived from title / description / the source fields above, which it never mutates.
  careerLevel?: CareerLevelVerdict | null;

  constructor(partial?: Partial<JobPostDto>) {
    Object.assign(this, partial);
  }
}
