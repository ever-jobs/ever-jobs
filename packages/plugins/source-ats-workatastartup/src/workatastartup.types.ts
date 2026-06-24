/**
 * Shapes of the Inertia.js `data-page` payload embedded in YC Work at a Startup
 * pages (Spec 5023). Only the fields the plugin reads are typed; everything is
 * optional because the blob is an untrusted external payload.
 */

/** A single opening from `props.jobPostings[]` (company page) or `props.job`. */
export interface WaasJobPosting {
  id?: number | string | null;
  title?: string | null;
  /** Relative detail path, e.g. `/companies/{slug}/jobs/{id}-{job-slug}`. */
  url?: string | null;
  /** The `workatastartup.com/application?...` (or YC auth) apply target. */
  applyUrl?: string | null;
  /** Free-text location, ` / `-delimited for multi-site roles. */
  location?: string | null;
  /** Normalisable employment type label, e.g. `Full-time`. */
  type?: string | null;
  /** Human-facing job function, e.g. `Engineering`. */
  prettyRole?: string | null;
  /** Internal role code, e.g. `eng`. */
  role?: string | null;
  salaryRange?: string | null;
  equityRange?: string | null;
  minExperience?: string | null;
  visa?: string | null;
  skills?: string[] | null;
  companyName?: string | null;
  /** Present only on the detail page's `props.job` (markdown body). */
  description?: string | null;
}

/** `props.company` on the company jobs page. */
export interface WaasCompany {
  id?: number | string | null;
  slug?: string | null;
  name?: string | null;
  website?: string | null;
  location?: string | null;
  country?: string | null;
  one_liner?: string | null;
  logo_url?: string | null;
}

/** The `props` object of the Inertia page. */
export interface WaasPageProps {
  company?: WaasCompany | null;
  jobPostings?: WaasJobPosting[] | null;
  /** Detail page carries a single `job`. */
  job?: WaasJobPosting | null;
}

/** The decoded `data-page` Inertia payload. */
export interface WaasInertiaPage {
  component?: string | null;
  props?: WaasPageProps | null;
}
