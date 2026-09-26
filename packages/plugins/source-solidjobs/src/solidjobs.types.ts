/**
 * Wire shapes of the solid.jobs public offers API
 * (`GET /public-api/offers/{division}?campaign={campaign}&pageSize={n}&pageIndex={i}`).
 * Polish job board with mandatory salary transparency.
 * Field set verified against a live payload on 2026-06-11; the paging
 * envelope and `secondarySalary` re-verified live on 2026-09-24 (Spec 1709).
 */

export interface SolidJobsSalary {
  from: number;
  to: number;
  currency: string; // "PLN" observed
  period: string; // "Month" observed
  employmentType: string; // "UoP" | "B2B" | "UZ" | "UoD" observed
}

export interface SolidJobsSkill {
  level: string; // "Expert" | "Advanced" | "Basic" | "NiceToHave" observed
  name: string;
}

export interface SolidJobsLanguage {
  level: string;
  name: string;
}

export interface SolidJobsOffer {
  jobOfferKey: string; // uuid
  title: string;
  division: string; // e.g. "IT", "Sales" (capitalised; the URL path is lower-case)
  category: string; // CamelCase code, e.g. "Developer", "B2BSales"
  subCategory: string; // CamelCase code, e.g. "Java", "TestAutomationEngineer"
  company: string;
  companyLogoUrl?: string | null;
  salary: SolidJobsSalary | null;
  /** A second contract form offered for the same role (e.g. UZ primary, B2B secondary). */
  secondarySalary?: SolidJobsSalary | null;
  contractTime?: string | null; // "full_time" | "part_time" observed
  locations?: string[] | null; // city names
  benefits: string[];
  isRemote: boolean;
  isHybrid: boolean;
  url: string; // absolute offer URL
  experienceLevel?: string | null; // "Junior" | "Regular" | "Senior" observed
  skills?: SolidJobsSkill[] | null;
  languages: SolidJobsLanguage[];
  description: string; // HTML
  /** Publish or refresh instant, e.g. `2026-09-24T15:53:51.3998022+02:00`. */
  validFrom?: string;
  validTo?: string;
  updatedAt?: string;
}

/**
 * One page of offers. The envelope fields are optional so a payload without
 * them (the Spec 718 shape) still parses.
 */
export interface SolidJobsResponse {
  jobs: SolidJobsOffer[];
  pageIndex?: number;
  pageSize?: number;
  totalCount?: number;
  totalPages?: number;
}
