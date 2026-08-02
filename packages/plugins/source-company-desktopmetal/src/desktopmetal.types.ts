import { CompensationInterval } from '@ever-jobs/models';

/** One open role parsed from the careers listing page. */
export interface DesktopmetalOpening {
  /** Role title, e.g. "Mechanical Engineer I". */
  title: string;
  /** Raw location text from the listing, e.g. "Burlington, MA" (may be empty). */
  location: string;
  /** Department heading the role sits under, e.g. "Engineering" (may be null). */
  department: string | null;
  /** Absolute URL of the role's PDF job description. */
  pdfUrl: string;
}

/** A parsed pay range extracted from a role's PDF text. */
export interface DesktopmetalPay {
  /** Numeric range text ready for the shared salary parser, or null. */
  text: string | null;
  /** Authoritative interval from the PDF's pay label / token, or undefined. */
  interval: CompensationInterval | undefined;
}
