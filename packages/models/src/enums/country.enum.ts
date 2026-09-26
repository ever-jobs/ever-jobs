/**
 * Country enum with Indeed and Glassdoor domain configuration.
 * Each entry has: countryNames, indeedSubdomain[:apiCode], glassdoorTld.
 */
export interface CountryConfig {
  /** Comma-separated lowercase country names for lookup */
  names: string;
  /** Indeed subdomain[:apiCountryCode] */
  indeed: string;
  /** Glassdoor TLD (e.g. 'com', 'co.uk', 'fr:be') */
  glassdoor?: string;
}

export enum Country {
  ARGENTINA = 'ARGENTINA',
  AUSTRALIA = 'AUSTRALIA',
  AUSTRIA = 'AUSTRIA',
  BAHRAIN = 'BAHRAIN',
  BANGLADESH = 'BANGLADESH',
  BELGIUM = 'BELGIUM',
  BULGARIA = 'BULGARIA',
  BRAZIL = 'BRAZIL',
  CANADA = 'CANADA',
  CHILE = 'CHILE',
  CHINA = 'CHINA',
  COLOMBIA = 'COLOMBIA',
  COSTARICA = 'COSTARICA',
  CROATIA = 'CROATIA',
  CYPRUS = 'CYPRUS',
  CZECHREPUBLIC = 'CZECHREPUBLIC',
  DENMARK = 'DENMARK',
  ECUADOR = 'ECUADOR',
  EGYPT = 'EGYPT',
  ESTONIA = 'ESTONIA',
  FINLAND = 'FINLAND',
  FRANCE = 'FRANCE',
  GERMANY = 'GERMANY',
  GREECE = 'GREECE',
  HONGKONG = 'HONGKONG',
  HUNGARY = 'HUNGARY',
  INDIA = 'INDIA',
  INDONESIA = 'INDONESIA',
  IRELAND = 'IRELAND',
  ISRAEL = 'ISRAEL',
  ITALY = 'ITALY',
  JAPAN = 'JAPAN',
  KUWAIT = 'KUWAIT',
  LATVIA = 'LATVIA',
  LITHUANIA = 'LITHUANIA',
  LUXEMBOURG = 'LUXEMBOURG',
  MALAYSIA = 'MALAYSIA',
  MALTA = 'MALTA',
  MEXICO = 'MEXICO',
  MOROCCO = 'MOROCCO',
  NETHERLANDS = 'NETHERLANDS',
  NEWZEALAND = 'NEWZEALAND',
  NIGERIA = 'NIGERIA',
  NORWAY = 'NORWAY',
  OMAN = 'OMAN',
  PAKISTAN = 'PAKISTAN',
  PANAMA = 'PANAMA',
  PERU = 'PERU',
  PHILIPPINES = 'PHILIPPINES',
  POLAND = 'POLAND',
  PORTUGAL = 'PORTUGAL',
  QATAR = 'QATAR',
  ROMANIA = 'ROMANIA',
  SAUDIARABIA = 'SAUDIARABIA',
  SINGAPORE = 'SINGAPORE',
  SLOVAKIA = 'SLOVAKIA',
  SLOVENIA = 'SLOVENIA',
  SOUTHAFRICA = 'SOUTHAFRICA',
  SOUTHKOREA = 'SOUTHKOREA',
  SPAIN = 'SPAIN',
  SRILANKA = 'SRILANKA',
  SWEDEN = 'SWEDEN',
  SWITZERLAND = 'SWITZERLAND',
  TAIWAN = 'TAIWAN',
  THAILAND = 'THAILAND',
  TURKEY = 'TURKEY',
  UKRAINE = 'UKRAINE',
  UNITEDARABEMIRATES = 'UNITEDARABEMIRATES',
  UK = 'UK',
  USA = 'USA',
  URUGUAY = 'URUGUAY',
  VENEZUELA = 'VENEZUELA',
  VIETNAM = 'VIETNAM',
  US_CANADA = 'US_CANADA',
  WORLDWIDE = 'WORLDWIDE',
}

export const COUNTRY_CONFIG: Record<Country, CountryConfig> = {
  [Country.ARGENTINA]: { names: 'argentina', indeed: 'ar', glassdoor: 'com.ar' },
  [Country.AUSTRALIA]: { names: 'australia', indeed: 'au', glassdoor: 'com.au' },
  [Country.AUSTRIA]: { names: 'austria', indeed: 'at', glassdoor: 'at' },
  [Country.BAHRAIN]: { names: 'bahrain', indeed: 'bh' },
  [Country.BANGLADESH]: { names: 'bangladesh', indeed: 'bd' },
  [Country.BELGIUM]: { names: 'belgium', indeed: 'be', glassdoor: 'fr:be' },
  [Country.BULGARIA]: { names: 'bulgaria', indeed: 'bg' },
  [Country.BRAZIL]: { names: 'brazil', indeed: 'br', glassdoor: 'com.br' },
  [Country.CANADA]: { names: 'canada', indeed: 'ca', glassdoor: 'ca' },
  [Country.CHILE]: { names: 'chile', indeed: 'cl' },
  [Country.CHINA]: { names: 'china', indeed: 'cn' },
  [Country.COLOMBIA]: { names: 'colombia', indeed: 'co' },
  [Country.COSTARICA]: { names: 'costa rica', indeed: 'cr' },
  [Country.CROATIA]: { names: 'croatia', indeed: 'hr' },
  [Country.CYPRUS]: { names: 'cyprus', indeed: 'cy' },
  [Country.CZECHREPUBLIC]: { names: 'czech republic,czechia', indeed: 'cz' },
  [Country.DENMARK]: { names: 'denmark', indeed: 'dk' },
  [Country.ECUADOR]: { names: 'ecuador', indeed: 'ec' },
  [Country.EGYPT]: { names: 'egypt', indeed: 'eg' },
  [Country.ESTONIA]: { names: 'estonia', indeed: 'ee' },
  [Country.FINLAND]: { names: 'finland', indeed: 'fi' },
  [Country.FRANCE]: { names: 'france', indeed: 'fr', glassdoor: 'fr' },
  [Country.GERMANY]: { names: 'germany', indeed: 'de', glassdoor: 'de' },
  [Country.GREECE]: { names: 'greece', indeed: 'gr' },
  [Country.HONGKONG]: { names: 'hong kong', indeed: 'hk', glassdoor: 'com.hk' },
  [Country.HUNGARY]: { names: 'hungary', indeed: 'hu' },
  [Country.INDIA]: { names: 'india', indeed: 'in', glassdoor: 'co.in' },
  [Country.INDONESIA]: { names: 'indonesia', indeed: 'id' },
  [Country.IRELAND]: { names: 'ireland', indeed: 'ie', glassdoor: 'ie' },
  [Country.ISRAEL]: { names: 'israel', indeed: 'il' },
  [Country.ITALY]: { names: 'italy', indeed: 'it', glassdoor: 'it' },
  [Country.JAPAN]: { names: 'japan', indeed: 'jp' },
  [Country.KUWAIT]: { names: 'kuwait', indeed: 'kw' },
  [Country.LATVIA]: { names: 'latvia', indeed: 'lv' },
  [Country.LITHUANIA]: { names: 'lithuania', indeed: 'lt' },
  [Country.LUXEMBOURG]: { names: 'luxembourg', indeed: 'lu' },
  [Country.MALAYSIA]: { names: 'malaysia', indeed: 'malaysia:my', glassdoor: 'com' },
  [Country.MALTA]: { names: 'malta', indeed: 'malta:mt', glassdoor: 'mt' },
  [Country.MEXICO]: { names: 'mexico', indeed: 'mx', glassdoor: 'com.mx' },
  [Country.MOROCCO]: { names: 'morocco', indeed: 'ma' },
  [Country.NETHERLANDS]: { names: 'netherlands', indeed: 'nl', glassdoor: 'nl' },
  [Country.NEWZEALAND]: { names: 'new zealand', indeed: 'nz', glassdoor: 'co.nz' },
  [Country.NIGERIA]: { names: 'nigeria', indeed: 'ng' },
  [Country.NORWAY]: { names: 'norway', indeed: 'no' },
  [Country.OMAN]: { names: 'oman', indeed: 'om' },
  [Country.PAKISTAN]: { names: 'pakistan', indeed: 'pk' },
  [Country.PANAMA]: { names: 'panama', indeed: 'pa' },
  [Country.PERU]: { names: 'peru', indeed: 'pe' },
  [Country.PHILIPPINES]: { names: 'philippines', indeed: 'ph' },
  [Country.POLAND]: { names: 'poland', indeed: 'pl' },
  [Country.PORTUGAL]: { names: 'portugal', indeed: 'pt' },
  [Country.QATAR]: { names: 'qatar', indeed: 'qa' },
  [Country.ROMANIA]: { names: 'romania', indeed: 'ro' },
  [Country.SAUDIARABIA]: { names: 'saudi arabia', indeed: 'sa' },
  [Country.SINGAPORE]: { names: 'singapore', indeed: 'sg', glassdoor: 'sg' },
  [Country.SLOVAKIA]: { names: 'slovakia', indeed: 'sk' },
  // 'SI' is Slovenia; 'SL' would be Sierra Leone
  [Country.SLOVENIA]: { names: 'slovenia', indeed: 'si' },
  [Country.SOUTHAFRICA]: { names: 'south africa', indeed: 'za' },
  [Country.SOUTHKOREA]: { names: 'south korea', indeed: 'kr' },
  [Country.SPAIN]: { names: 'spain', indeed: 'es', glassdoor: 'es' },
  [Country.SRILANKA]: { names: 'sri lanka,srilanka', indeed: 'lk' },
  [Country.SWEDEN]: { names: 'sweden', indeed: 'se' },
  [Country.SWITZERLAND]: { names: 'switzerland', indeed: 'ch', glassdoor: 'de:ch' },
  [Country.TAIWAN]: { names: 'taiwan', indeed: 'tw' },
  [Country.THAILAND]: { names: 'thailand', indeed: 'th' },
  [Country.TURKEY]: { names: 'türkiye,turkey', indeed: 'tr' },
  [Country.UKRAINE]: { names: 'ukraine', indeed: 'ua' },
  [Country.UNITEDARABEMIRATES]: { names: 'united arab emirates', indeed: 'ae' },
  [Country.UK]: { names: 'uk,united kingdom', indeed: 'uk:gb', glassdoor: 'co.uk' },
  [Country.USA]: { names: 'usa,us,united states', indeed: 'www:us', glassdoor: 'com' },
  [Country.URUGUAY]: { names: 'uruguay', indeed: 'uy' },
  [Country.VENEZUELA]: { names: 'venezuela', indeed: 've' },
  [Country.VIETNAM]: { names: 'vietnam', indeed: 'vn', glassdoor: 'com' },
  [Country.US_CANADA]: { names: 'usa/ca', indeed: 'www' },
  [Country.WORLDWIDE]: { names: 'worldwide', indeed: 'www' },
};

/**
 * Parse a country string into a Country enum value.
 */
export function countryFromString(countryStr: string): Country {
  const normalized = countryStr.trim().toLowerCase();
  for (const [country, config] of Object.entries(COUNTRY_CONFIG)) {
    const names = config.names.split(',');
    if (names.includes(normalized)) {
      return country as Country;
    }
  }
  const validNames = Object.values(COUNTRY_CONFIG).map((c) => c.names).join(', ');
  throw new Error(`Invalid country string: '${countryStr}'. Valid countries are: ${validNames}`);
}

/**
 * Get Indeed domain and API country code for a Country.
 */
export function getIndeedDomain(country: Country): { subdomain: string; apiCountryCode: string } {
  const config = COUNTRY_CONFIG[country];
  const parts = config.indeed.split(':');
  return {
    subdomain: parts[0],
    apiCountryCode: (parts[1] ?? parts[0]).toUpperCase(),
  };
}

/**
 * Get the Glassdoor domain URL for a Country.
 */
export function getGlassdoorDomain(country: Country): string {
  const config = COUNTRY_CONFIG[country];
  if (!config.glassdoor) {
    throw new Error(`Glassdoor is not available for ${country}`);
  }
  const parts = config.glassdoor.split(':');
  if (parts.length === 2) {
    return `${parts[0]}.glassdoor.${parts[1]}`;
  }
  return `www.glassdoor.${config.glassdoor}`;
}

export function getGlassdoorUrl(country: Country): string {
  return `https://${getGlassdoorDomain(country)}/`;
}

/**
 * Get the display name for a Country: the first configured name with every
 * word capitalised ('sri lanka' -> 'Sri Lanka'); 'usa' / 'uk' upper-cased.
 */
export function getCountryDisplayName(country: Country): string {
  const config = COUNTRY_CONFIG[country];
  const firstName = config.names.split(',')[0];
  if (['usa', 'uk'].includes(firstName)) {
    return firstName.toUpperCase();
  }
  return firstName.replace(/(^|\s)(\S)/g, (_, space: string, first: string) =>
    space + first.toUpperCase(),
  );
}
