/**
 * Internal types for the PrismHR / HiringThing adapter.
 */

/** A job record parsed from the board list page `data-react-props`. */
export interface PrismhrListItem {
  jobId: number;
  title: string;
  city: string | null;
  state: string | null;
  isRemote: boolean;
  department: string | null;
}

/** Fields extracted from the detail page JSON-LD + React props. */
export interface PrismhrDetailData {
  descriptionHtml: string | null;
  datePosted: string | null;
  employmentType: string | null;
  hiringOrganizationName: string | null;
  isRemote: boolean;
  city: string | null;
  state: string | null;
  country: string | null;
  minSalary: number | null;
  maxSalary: number | null;
  payFrequency: string | null;
  currency: string | null;
  category: string | null;
}

/** Shape of the `data-react-props` on `HiringThing.Components.JobFiltersContainer`. */
export interface PrismhrBoardProps {
  titles: Array<{ id: number; title: string }>;
  locations: Record<string, Record<string, number[]>>;
  categories: Record<string, number[]>;
  remotePositions: number[];
}

/** Shape of the `jobObj.table` inside `ApplyButtonGroup` React props. */
export interface PrismhrDetailTableProps {
  id: number;
  company_name: string;
  title: string;
  html_description: string;
  posted_at: string;
  location: string;
  location_info: {
    country: string;
    city: string;
    state: string;
    zipcode: string;
  };
  category: string | null;
  remote: boolean;
  min_salary: Record<string, unknown> | null;
  max_salary: Record<string, unknown> | null;
  pay_frequency: string;
}
