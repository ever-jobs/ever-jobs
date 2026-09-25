export const ZENNOASTRONAUTICS_COMPANY_NAME = 'Zenno Astronautics';
export const ZENNOASTRONAUTICS_ORIGIN = 'https://www.zennoastronautics.com';
export const ZENNOASTRONAUTICS_CAREERS_URL = `${ZENNOASTRONAUTICS_ORIGIN}/careers`;
export const ZENNOASTRONAUTICS_SANITY_QUERY_URL =
  'https://zsx1k6t6.api.sanity.io/v2021-10-21/data/query/production';
export const ZENNOASTRONAUTICS_JOBS_GROQ =
  '*[_type == "job" && isActive == true]{title, slug, location, type, compensation, "text": description[]{style, listItem, children, markDefs}}';
export const ZENNOASTRONAUTICS_DEFAULT_TIMEOUT_SECONDS = 30;
