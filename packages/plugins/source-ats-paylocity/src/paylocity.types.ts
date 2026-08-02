/**
 * TypeScript interfaces for the Paylocity recruiting board.
 *
 * Spec 5020 — sourced from the server-rendered board page (`window.pageData`)
 * and the per-job detail page, not the (dead) JSON feed endpoint.
 */

import type { JobPostingLdSalary } from '@ever-jobs/common';

/** Nested location object on each board job (`Jobs[].JobLocation`). */
export interface PaylocityJobLocation {
  City?: string | null;
  State?: string | null;
  Zip?: string | null;
  Country?: string | null;
  Name?: string | null;
}

/** A single job as embedded in the board page's `window.pageData.Jobs[]`. */
export interface PaylocityListJob {
  JobId: string | number;
  JobTitle: string;
  /** Empty string on the board list — the real body lives on the detail page. */
  Description?: string | null;
  LocationName?: string | null;
  JobLocation?: PaylocityJobLocation | null;
  HiringDepartment?: string | null;
  /** ISO timestamp with offset, e.g. `2026-06-11T16:42:33-05:00`. */
  PublishedDate?: string | null;
  IsRemote?: boolean | null;
  /** Indeed work-mode hint: 1 = remote, 2 = on-site (observed). */
  IndeedRemoteType?: number | null;
}

/** The `window.pageData` object server-rendered into the board page. */
export interface PaylocityPageData {
  /** Company display name, e.g. `Fermi LLC`. */
  ModuleTitle?: string | null;
  Jobs?: PaylocityListJob[] | null;
}

/**
 * Fields parsed from a job's detail page (`/recruiting/jobs/Details/...`).
 * The board list cannot provide these.
 */
export interface PaylocityJobDetail {
  /** Full posting body as HTML (Description + any Requirements/other sections). */
  description: string | null;
  /** Employment type label, e.g. `Full-time`; absent on some jobs. */
  jobType: string | null;
  /** Structured pay from the detail page's ld+json `baseSalary`, when present. */
  baseSalary: JobPostingLdSalary | null;
}
