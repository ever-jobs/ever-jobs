/**
 * Internal types for the Submit4Jobs / Pereless adapter.
 */

/** API coordinates discovered from the board's embed `<script src>`. */
export interface Submit4jobsApiCoords {
  /** API host, e.g. `apps.submit4jobs.com` or `devapps.pereless.com`. */
  apiHost: string;
  /** Board template, e.g. `magneto` or `magnetolive`. */
  template: string;
  /** Numeric company id passed as the `cid` header and in cookies. */
  cid: string;
}

/**
 * A raw job object from the `getJobs` API. Only the fields the adapter consumes
 * are typed; the payload carries many more.
 */
export interface Submit4jobsJob {
  jid?: number | string;
  job_title?: string;
  jobkeyword?: string;
  companyname?: string;
  dname?: string;
  city?: string;
  state?: string;
  fullStateName?: string;
  country?: string;
  fullCountryName?: string;
  location?: string;
  jobtype?: string;
  postingdate?: string;
  statusdate?: string;
  jobdescription?: string;
  reqsexp?: string;
  salary?: string | number;
  salaryrange?: string | number;
  salarytype?: string | number;
  jobcurrency?: string;
}
