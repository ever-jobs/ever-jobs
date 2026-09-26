import { JobType } from '../enums/job-type.enum';
import { DatePostedBasis, DatePostedPrecision } from '../enums/date-posted.enum';
import { LocationDto } from './location.dto';
import { OfficeDto } from './office.dto';
import { CompensationDto } from './compensation.dto';

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

  /** Posting instant, ISO-8601 UTC (`...Z`). Present only when the source gives
   *  finer-than-day information (Spec 1696). `datePosted` stays the date-only
   *  canonical value. */
  datePostedAt?: string | null;
  /** Granularity of the posting time (how wide the error bar is). */
  datePostedPrecision?: DatePostedPrecision | null;
  /** Where the posting time came from. `relative` = estimated from an age label at fetch time. */
  datePostedBasis?: DatePostedBasis | null;

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

  // LinkedIn detail page (Spec 1701); other sources may fill them later.
  /** The source's own numeric company id (LinkedIn `meta[name=companyId]`). */
  companySourceId?: string | null;
  /** Applicant count shown on the posting. */
  applicantsCount?: number | null;
  /** How `applicantsCount` bounds the real number: "154 applicants" = exact, "Over 200" = min, "Be among the first 25" = max. */
  applicantsCountBound?: 'exact' | 'min' | 'max' | null;

  // Level (jobsbylevel.com) AI-centrality rating, 1-4 - not seniority (Spec 1693).
  // `JOBSBYLEVEL_EMIT_AI_LEVEL=false` leaves it off.
  aiLevel?: number | null;

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

  constructor(partial?: Partial<JobPostDto>) {
    Object.assign(this, partial);
  }
}
