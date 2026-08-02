/**
 * TypeScript interfaces for the ADP Workforce Now public career-center staffing
 * API (`.../staffing/v1/job-requisitions`). Field names mirror the real payload:
 * the list feed carries `requisitionTitle` / `itemID` / `requisitionLocations` /
 * `workLevelCode` / `payGradeRange`, and the per-requisition detail endpoint adds
 * `requisitionDescription`.
 */

export interface AdpResponse {
  jobRequisitions?: AdpJob[];
  meta?: {
    totalNumber?: number;
  };
}

export interface AdpJob {
  /** Stable requisition id, e.g. "9201050875412_1" (used for detail + URL). */
  itemID?: string | null;
  /** Job title. */
  requisitionTitle?: string | null;
  /** Posting body — present only on the per-requisition detail payload. */
  requisitionDescription?: string | null;
  /** Posting date (ISO 8601 with offset). */
  postDate?: string | null;
  /** Structured locations. */
  requisitionLocations?: AdpLocation[] | null;
  /** Work level, e.g. `{ shortName: "Full Time" }` (employment type). */
  workLevelCode?: AdpCodeName | null;
  /** Structured pay range. */
  payGradeRange?: AdpPayGradeRange | null;
  /** Custom fields; carries the human-readable "SalaryRange" string. */
  customFieldGroup?: AdpCustomFieldGroup | null;
}

export interface AdpLocation {
  /** Display label, e.g. `{ shortName: "Washington, DC, US" }`. */
  nameCode?: AdpCodeName | null;
  address?: AdpAddress | null;
}

export interface AdpAddress {
  cityName?: string | null;
  countrySubdivisionLevel1?: AdpCodeValue | null;
  countryCode?: string | null;
}

export interface AdpCodeName {
  shortName?: string | null;
  codeValue?: string | null;
}

export interface AdpCodeValue {
  codeValue?: string | null;
  shortName?: string | null;
}

export interface AdpRate {
  amountValue?: number | null;
  currencyCode?: string | null;
}

export interface AdpPayGradeRange {
  minimumRate?: AdpRate | null;
  maximumRate?: AdpRate | null;
}

export interface AdpCustomFieldGroup {
  stringFields?: AdpStringField[] | null;
}

export interface AdpStringField {
  stringValue?: string | null;
  nameCode?: AdpCodeValue | null;
}
