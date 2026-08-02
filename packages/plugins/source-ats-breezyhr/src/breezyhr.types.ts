/**
 * BreezyHR public job-board shapes.
 *
 * The company list endpoint (`/json`) returns sparse records (no description).
 * The per-job detail page (`/p/{friendly_id}`) is HTML carrying a schema.org
 * `JobPosting` ld+json block with the rich body.
 */

import type { JobPostingLdSalary } from '@ever-jobs/common';

/** A location node from the list endpoint. `state`/`country` are objects. */
export interface BreezyLocation {
  city?: string | null;
  /** `{ id: "TX", name: "Texas" }` on the public list (not a bare string). */
  state?: { id?: string | null; name?: string | null } | string | null;
  /** `{ id: "US", name: "United States" }` on the public list. */
  country?: { id?: string | null; name?: string | null } | string | null;
  /** Pre-joined label, e.g. "Austin, TX". */
  name?: string | null;
  is_remote?: boolean | null;
}

/** Employment-type node, e.g. `{ id: "fullTime", name: "Full-Time" }`. */
export interface BreezyType {
  id?: string | null;
  name?: string | null;
}

/** A single posting from `GET https://{slug}.breezy.hr/json`. */
export interface BreezyJob {
  id?: string | null;
  friendly_id?: string | null;
  name?: string | null;
  title?: string | null;
  department?: string | null;
  category?: { name?: string | null } | null;
  type?: BreezyType | null;
  location?: BreezyLocation | null;
  locations?: BreezyLocation[] | null;
  published_date?: string | null;
  creation_date?: string | null;
  /** Free-text pay range, e.g. "$105k - $125k" or "$19.00 - $27.00 / hr". */
  salary?: string | null;
  /** Employer display name, e.g. `{ name: "Ondas Inc." }` (not the slug). */
  company?: { name?: string | null } | null;
  url?: string | null;
  description?: string | null;
}

/**
 * Per-job overlay parsed from the detail page's schema.org `JobPosting` ld+json:
 * the full description body and the structured `baseSalary` (absent on the list).
 */
export interface BreezyDetail {
  description: string | null;
  baseSalary: JobPostingLdSalary | null;
}
