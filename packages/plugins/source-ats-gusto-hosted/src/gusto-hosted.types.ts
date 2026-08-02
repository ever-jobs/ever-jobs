import { CompensationDto } from '@ever-jobs/models';

/** A single posting enumerated from a tenant board page. */
export interface GustoHostedListItem {
  /** The `/postings/{postingSlug}` path token — stable per role. */
  postingSlug: string;
  /** Title text from the board anchor (best-effort; detail JSON-LD wins). */
  title: string;
  /** Absolute posting detail URL. */
  jobUrl: string;
}

/** The merged fields pulled from a posting detail page (JSON-LD first). */
export interface GustoHostedDetailData {
  title: string | null;
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
