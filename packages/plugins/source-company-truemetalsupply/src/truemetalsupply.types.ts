/** A single opening scraped from a Wix job-description dialog. */
export interface TrueMetalSupplyOpening {
  /** The rendered role title (the dialog's first line, e.g. "Project Estimator"). */
  title: string;
  /** The dialog body's inner HTML (converted to markdown for the description). */
  descriptionHtml: string | null;
  /** The dialog body's plain text (used for job-dialog detection). */
  descriptionText: string;
}
