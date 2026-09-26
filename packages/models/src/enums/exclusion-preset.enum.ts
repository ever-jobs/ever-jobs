/**
 * Curated exclusion lists a search caller can opt into (Spec 1700).
 *
 * The enum lives in `models` because `ScraperInputDto` validates against it;
 * the term lists themselves live next to the matcher in
 * `@ever-jobs/common` (`EXCLUSION_PRESET_TERMS`), since `common` depends on
 * `models` and not the other way round. Adding a preset is a data-only change
 * there plus one enum member here.
 */
export enum ExclusionPreset {
  /**
   * Roles that require, or ask the candidate to obtain, a government security
   * clearance or vetting (US, UK, Canadian and Australian vocabulary). Matched
   * against the title and the description.
   */
  SECURITY_CLEARANCE = 'security_clearance',
}
