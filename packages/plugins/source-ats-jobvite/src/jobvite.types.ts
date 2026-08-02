/**
 * TypeScript interfaces for the Jobvite server-rendered career board.
 */
import { CompensationDto } from '@ever-jobs/models';

/** A normalised row parsed from the `/{slug}/jobs` list under its department heading. */
export interface JobviteListItem {
  /** Stable job id (the `/job/{jobId}` path token). */
  jobId: string;
  /** Job title. */
  title: string;
  /** Canonical detail / apply URL. */
  jobUrl: string;
  /** Department — the `<h3 class="h2">` heading the row is grouped under. */
  department: string | null;
  /** Raw location cell text (e.g. "Corvallis, Oregon" or "Remote, United States"). */
  locationText: string | null;
}

/** Detail fields pulled from a role's JSON-LD `JobPosting`. */
export interface JobviteDetailData {
  descriptionHtml: string | null;
  datePosted: string | null;
  employmentType: string | null;
  hiringOrganizationName: string | null;
  isRemote: boolean;
  city: string | null;
  state: string | null;
  country: string | null;
  compensation: CompensationDto | null;
}
