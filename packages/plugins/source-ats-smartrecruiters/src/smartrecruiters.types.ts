/**
 * TypeScript interfaces for SmartRecruiters API responses.
 */

export interface SmartRecruitersLocation {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  remote?: boolean | null;
}

export interface SmartRecruitersDepartment {
  id?: string | null;
  label?: string | null;
}

export interface SmartRecruitersJobAd {
  sections?: {
    jobDescription?: { title?: string; text?: string } | null;
    qualifications?: { title?: string; text?: string } | null;
    additionalInformation?: { title?: string; text?: string } | null;
    companyDescription?: { title?: string; text?: string } | null;
  } | null;
}

export interface SmartRecruitersJob {
  id?: string | null;
  name?: string | null;
  uuid?: string | null;
  refNumber?: string | null;
  releasedDate?: string | null;
  location?: SmartRecruitersLocation | null;
  department?: SmartRecruitersDepartment | null;
  experienceLevel?: { id?: string; label?: string } | null;
  typeOfEmployment?: { id?: string; label?: string } | null;
  /**
   * The posting's **API resource** URL —
   * `https://api.smartrecruiters.com/v1/companies/<Co>/postings/<id>` (JSON).
   * Present on list and detail responses. Never a user-facing link (Spec 1750):
   * only the company identifier and posting id are read from it, as fallbacks.
   */
  ref?: string | null;
  /**
   * The public posting page, e.g.
   * `https://jobs.smartrecruiters.com/AbbVie/3743990015679966-head-of-…`.
   * Returned by the posting **detail** endpoint only; the list endpoint omits it
   * (verified live 2026-09-25).
   */
  postingUrl?: string | null;
  /**
   * The public apply page (`<postingUrl>?oga=true`). Detail endpoint only, like
   * `postingUrl`.
   */
  applyUrl?: string | null;
  /** `identifier` is the case-sensitive company key the public pages use. */
  company?: { name?: string; identifier?: string } | null;
  /** Posting body. Detail endpoint only; the list endpoint omits it. */
  jobAd?: SmartRecruitersJobAd | null;
}

export interface SmartRecruitersResponse {
  content: SmartRecruitersJob[];
  totalFound?: number;
  offset?: number;
  limit?: number;
}
