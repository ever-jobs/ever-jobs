/**
 * Wire shapes of the public bdjobs.com JSON API (Spec 1711).
 *
 * The API is unversioned and undocumented, so every field is optional or
 * nullable and every consumer checks the shape before trusting it.
 */

/** One row of a search page (`data[]` or `premiumData[]`). */
export interface BdjobsListItem {
  Jobid?: string | number | null;
  /** '0' | '1' | '2'; '2' is a premium ad. */
  AdType?: string | null;
  jobTitle?: string | null;
  JobTitleBng?: string | null;
  companyName?: string | null;
  /** Human deadline, e.g. 'Oct 24, 2026'. Never a posting date. */
  deadline?: string | null;
  deadlineDB?: string | null;
  /** ISO timestamp, e.g. '2026-09-24T12:19:00Z'. */
  publishDate?: string | null;
  /** Education requirements (plain lines, sometimes HTML). */
  eduRec?: string | null;
  /** '5 to 7 years' | 'At least 4 years' | 'NA'. */
  experience?: string | null;
  standout?: number | null;
  logo?: string | null;
  lantype?: number | null;
  location?: string | null;
  JobLang?: string | null;
  /** Short HTML context/summary, or null. */
  jobContext?: string | null;
  isEarlyAccess?: boolean | null;
  OnlineJob?: boolean | null;
  logoUrl?: string | null;
  /**
   * NOT a description: a truncated copy of `eduRec`. Never mapped
   * (Spec 1711 pitfall 1).
   */
  jobDescription?: string | null;
  /** 'FullTime' | 'Contract' | ... */
  JobType?: string | null;
  Vacancies?: number | string | null;
  /** 'Tk. 35000 - 50000 (Monthly)' | 'Tk. 15000 (Monthly)' | '--'. */
  Salary?: string | null;
  /** 'Office' | 'Home' | 'Home,Office' | ''. */
  WorkPlace?: string | null;
  Cat_id?: number | null;
}

export interface BdjobsSearchCommon {
  total_records_found?: number | string | null;
  totalpages?: number | string | null;
  total_vacancies?: number | string | null;
  showd?: string | null;
}

export interface BdjobsSearchResponse {
  message?: string | null;
  /** '1' on success. Not trusted: success is judged by shape. */
  statuscode?: string | null;
  data?: BdjobsListItem[] | null;
  premiumData?: BdjobsListItem[] | null;
  common?: BdjobsSearchCommon | null;
}

/**
 * The details fields the plugin reads. The payload carries more (including an
 * echo of the caller's public IP) that is deliberately not modelled, mapped or
 * logged.
 */
export interface BdjobsDetail {
  JobId?: string | number | null;
  /** 'True' | 'False'. */
  JobFound?: string | null;
  Closed?: number | string | boolean | null;
  error?: string | null;
  JobTitle?: string | null;
  /** Sic: the API spells it this way. */
  CompnayName?: string | null;
  CompanyNameENG?: string | null;
  CompanyID?: string | null;
  /** 'Sep 23, 2026'. */
  PostedOn?: string | null;
  Deadline?: string | null;
  DeadlineDB?: string | null;
  /** '--' or a number string. */
  JobVacancies?: string | number | null;
  /** 'Contractual' | 'Full Time' | ... */
  JobNature?: string | null;
  /** 'Work from home' | ... */
  JobWorkPlace?: string | null;
  JobDescription?: string | null;
  EducationRequirements?: string | null;
  experience?: string | null;
  AdditionJobRequirements?: string | null;
  JobOtherBenifits?: string | null;
  Context?: string | null;
  SkillsRequired?: string | null;
  SuggestedSkills?: string | null;
  JobLocation?: string | null;
  CompanyAddress?: string | null;
  CompanyHideAddress?: string | null;
  CompanyWeb?: string | null;
  CompanyBusiness?: string | null;
  JobSalaryRange?: string | null;
  JobSalaryMinSalary?: string | number | null;
  JobSalaryMaxSalary?: string | number | null;
  ShowSalary?: string | null;
  ApplyEmail?: string | null;
  ApplyURL?: string | null;
  OnlineApply?: string | null;
  JobLOgoName?: string | null;
}

export interface BdjobsDetailResponse {
  /** '0' on success (unlike search's '1'). Not trusted: judged by shape. */
  statuscode?: string | null;
  message?: string | null;
  data?: BdjobsDetail[] | null;
  common?: unknown;
}
