/**
 * Normalised shapes parsed from an iCIMS board page.
 */

/** One job card parsed from a board listings page. */
export interface IcimsListItem {
  jobId: string;
  title: string;
  url: string;
  city: string | null;
  state: string | null;
  country: string | null;
  locationRaw: string | null;
  department: string | null;
  descriptionSnippet: string | null;
  isRemote: boolean;
}

/** The result of parsing a single board page. */
export interface IcimsBoardPage {
  items: IcimsListItem[];
  totalPages: number | null;
  companyName: string | null;
}
