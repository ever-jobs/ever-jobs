/**
 * Shape of a single job object returned by the RemoteOK API.
 * The API returns a JSON array whose elements are a metadata object (with a
 * "legal" key, normally first) and job objects. Rows are told apart by shape,
 * not by position (Spec 1707).
 *
 * Every field the API has been seen to omit or leave empty is optional; text
 * fields arrive double-encoded (UTF-8 bytes read as Latin-1) and are repaired
 * before use.
 */
export interface RemoteOkJob {
  slug?: string;
  /** Numeric string on the wire (`"1137427"`); a number is accepted too. */
  id: string | number;
  /** Unix seconds. */
  epoch?: number;
  /** ISO 8601 with an offset. */
  date?: string;
  company?: string;
  company_logo?: string;
  /** Second logo field; empty whenever `company_logo` is. */
  logo?: string;
  position: string;
  tags?: string[];
  /** HTML. */
  description?: string;
  /** Free text; often empty. */
  location?: string;
  /** Always the board's own job page in practice, not the employer's form. */
  apply_url?: string;
  /** `0` means unknown. */
  salary_min?: number;
  /** `0` means unknown. */
  salary_max?: number;
  url?: string;
  original?: boolean;
  verified?: boolean;
}

/** The metadata row (normally element 0). */
export interface RemoteOkMeta {
  /** Unix seconds. */
  last_updated?: number;
  /** The API terms of use. */
  legal?: string;
}
