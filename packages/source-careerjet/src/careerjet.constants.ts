import { Country } from '@ever-jobs/models';

export const CAREERJET_API_URL = 'https://public.api.careerjet.net/search';

export const CAREERJET_HEADERS = {
  'Accept': 'application/json',
};

/** Map Country enum to CareerJet locale codes */
export const COUNTRY_TO_LOCALE: Partial<Record<Country, string>> = {
  [Country.USA]: 'en_US',
  [Country.UK]: 'en_GB',
  [Country.AUSTRALIA]: 'en_AU',
  [Country.CANADA]: 'en_CA',
  [Country.GERMANY]: 'de_DE',
  [Country.FRANCE]: 'fr_FR',
  [Country.SPAIN]: 'es_ES',
  [Country.ITALY]: 'it_IT',
  [Country.NETHERLANDS]: 'nl_NL',
  [Country.BRAZIL]: 'pt_BR',
  [Country.INDIA]: 'en_IN',
  [Country.JAPAN]: 'ja_JP',
  [Country.SOUTHKOREA]: 'ko_KR',
  [Country.CHINA]: 'zh_CN',
  [Country.MEXICO]: 'es_MX',
  [Country.POLAND]: 'pl_PL',
  [Country.SWEDEN]: 'sv_SE',
  [Country.NORWAY]: 'no_NO',
  [Country.DENMARK]: 'da_DK',
  [Country.FINLAND]: 'fi_FI',
  [Country.IRELAND]: 'en_IE',
  [Country.NEWZEALAND]: 'en_NZ',
  [Country.SOUTHAFRICA]: 'en_ZA',
  [Country.SINGAPORE]: 'en_SG',
  [Country.AUSTRIA]: 'de_AT',
  [Country.SWITZERLAND]: 'de_CH',
  [Country.BELGIUM]: 'fr_BE',
  [Country.PORTUGAL]: 'pt_PT',
};

export const DEFAULT_LOCALE = 'en_US';
export const DEFAULT_USER_AGENT = 'EverJobs/1.0 (+https://github.com/ever-co/ever-jobs)';
export const MAX_PAGE = 10;
export const DEFAULT_PAGE_SIZE = 50;
