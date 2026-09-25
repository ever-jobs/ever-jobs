import * as cheerio from 'cheerio';
import { CompensationInterval, JobType } from '@ever-jobs/models';
import {
  LINKEDIN_FETCH_COMPANY_DETAILS_ENV,
  LINKEDIN_LEGACY_ENV,
} from '../src/linkedin.constants';
import {
  companySlugFromUrl,
  detectRemoteSignal,
  externalHttpUrl,
  extractLinkedInJobId,
  isJobRemote,
  jobIdFromHref,
  jobTypeCode,
  jobTypeFromEmploymentType,
  licdnMediaUrl,
  linkedInBlockDiagnostics,
  linkedInBlockReason,
  normalizeCompanyUrl,
  parseApplicants,
  parseCompanyIndustry,
  parseCriteria,
  parseJobLevel,
  parseJobType,
  parseLegacyCardPay,
  parseLinkedInPay,
  resolveFetchCompanyDetails,
  resolveLinkedInLegacy,
  unwrapLinkedInRedirect,
} from '../src/linkedin.utils';

/** Spec 1701 — pure helpers behind the LinkedIn guest scraper. */

const CRITERIA_HTML = `
  <ul class="description__job-criteria-list">
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader"> Seniority level </h3>
      <span class="description__job-criteria-text"> Internship </span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader"> Employment type </h3>
      <span class="description__job-criteria-text"> Full-time </span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader"> Job function </h3>
      <span class="description__job-criteria-text"> Other </span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader"> Industries </h3>
      <span class="description__job-criteria-text"> Consumer Services </span>
    </li>
  </ul>`;

function criteria() {
  const $ = cheerio.load(CRITERIA_HTML);
  return { $, el: $('.description__job-criteria-list') };
}

describe('parseLinkedInPay (Spec 1701 §5.4)', () => {
  const cases: Array<[string, { min: number | null; max: number | null; currency: string; interval: CompensationInterval }]> = [
    ['$53,000.00/yr - $65,000.00/yr', { min: 53000, max: 65000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$20.00/hr - $25.00/hr', { min: 20, max: 25, currency: 'USD', interval: CompensationInterval.HOURLY }],
    ['€50,000.00/yr - €60,000.00/yr', { min: 50000, max: 60000, currency: 'EUR', interval: CompensationInterval.YEARLY }],
    ['£40,000.00/yr - £50,000.00/yr', { min: 40000, max: 50000, currency: 'GBP', interval: CompensationInterval.YEARLY }],
    ['CA$80,000.00/yr - CA$100,000.00/yr', { min: 80000, max: 100000, currency: 'CAD', interval: CompensationInterval.YEARLY }],
    ['A$90,000.00/yr - A$110,000.00/yr', { min: 90000, max: 110000, currency: 'AUD', interval: CompensationInterval.YEARLY }],
    ['₹1,200,000.00/yr - ₹1,800,000.00/yr', { min: 1200000, max: 1800000, currency: 'INR', interval: CompensationInterval.YEARLY }],
    ['SGD 6,000.00/mo - SGD 8,000.00/mo', { min: 6000, max: 8000, currency: 'SGD', interval: CompensationInterval.MONTHLY }],
    ['$1,500.00/wk - $1,800.00/wk', { min: 1500, max: 1800, currency: 'USD', interval: CompensationInterval.WEEKLY }],
    ['$300.00/day - $400.00/day', { min: 300, max: 400, currency: 'USD', interval: CompensationInterval.DAILY }],
    ['$120,000+', { min: 120000, max: null, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$25.00/hr+', { min: 25, max: null, currency: 'USD', interval: CompensationInterval.HOURLY }],
    ['up to $150,000/yr', { min: null, max: 150000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$85,000.00/yr', { min: 85000, max: 85000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$120K - $150K', { min: 120000, max: 150000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$1.2M - $1.5M', { min: 1200000, max: 1500000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$750,000.00/yr - $900,000.00/yr', { min: 750000, max: 900000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$137,750.00\n    -\n    $185,000.00', { min: 137750, max: 185000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$100,000 to $120,000', { min: 100000, max: 120000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$100,000 - 120,000', { min: 100000, max: 120000, currency: 'USD', interval: CompensationInterval.YEARLY }],
    ['$18.50 - $22.75', { min: 18.5, max: 22.75, currency: 'USD', interval: CompensationInterval.HOURLY }],
    ['$40 - $45 hourly', { min: 40, max: 45, currency: 'USD', interval: CompensationInterval.HOURLY }],
    ['$5,000 monthly', { min: 5000, max: 5000, currency: 'USD', interval: CompensationInterval.MONTHLY }],
    ['75,000.00 - 90,000.00', { min: 75000, max: 90000, currency: 'USD', interval: CompensationInterval.YEARLY }],
  ];

  it.each(cases)('%j', (input, expected) => {
    const pay = parseLinkedInPay(input);
    expect(pay).not.toBeNull();
    expect(pay!.minAmount).toBe(expected.min);
    expect(pay!.maxAmount).toBe(expected.max);
    expect(pay!.currency).toBe(expected.currency);
    expect(pay!.interval).toBe(expected.interval);
  });

  it.each([
    '$160,000/yr - $150,000/yr', // min > max
    '$20/hr - $40,000/yr', // two different periods
    '€50,000 - £60,000', // two different currencies
    'Competitive',
    'DOE',
    '',
    '   ',
    '$0',
    '$1 - $2 - $3',
    'up to $100 - $200',
  ])('returns null for %j', (input) => {
    expect(parseLinkedInPay(input)).toBeNull();
  });

  it('never throws on non-string or oversized input', () => {
    expect(parseLinkedInPay(null)).toBeNull();
    expect(parseLinkedInPay(undefined)).toBeNull();
    expect(parseLinkedInPay(42 as unknown as string)).toBeNull();
    expect(parseLinkedInPay(`$${'1'.repeat(5000)}`)).toBeNull();
    expect(parseLinkedInPay(`$1,000 ${'- '.repeat(3000)}`)).toBeNull();
  });

  it('reads a K suffix but not the "m" of a period word as a million', () => {
    expect(parseLinkedInPay('$5,000 monthly')!.minAmount).toBe(5000);
    expect(parseLinkedInPay('$5m')!.minAmount).toBe(5000000);
  });

  it('a second bound with no currency inherits the first (and the reverse)', () => {
    expect(parseLinkedInPay('£40,000 - 50,000')!.currency).toBe('GBP');
    expect(parseLinkedInPay('40,000 - £50,000')!.currency).toBe('GBP');
  });
});

describe('parseLegacyCardPay (pre-1701 card regex, kept for EVER_JOBS_LINKEDIN_LEGACY=pay)', () => {
  it('reads a plain dollar range as USD and uses the "hr" substring for hourly', () => {
    const yearly = parseLegacyCardPay('$120,000 - $150,000');
    expect(yearly).toMatchObject({ minAmount: 120000, maxAmount: 150000, currency: 'USD', interval: CompensationInterval.YEARLY });
    expect(parseLegacyCardPay('$20 - $25 hr')!.interval).toBe(CompensationInterval.HOURLY);
  });

  it('keeps its known defects: per-bound periods and CA$ ranges are dropped, € is labelled USD', () => {
    expect(parseLegacyCardPay('$53,000.00/yr - $65,000.00/yr')).toBeNull();
    expect(parseLegacyCardPay('CA$80,000 - CA$100,000')).toBeNull();
    expect(parseLegacyCardPay('€50,000 - 60,000')!.currency).toBe('USD');
  });

  it('returns null with no range', () => {
    expect(parseLegacyCardPay('Competitive')).toBeNull();
    expect(parseLegacyCardPay(null)).toBeNull();
  });
});

describe('parseApplicants (Spec 1701 §5.5)', () => {
  it.each([
    ['154 applicants', { count: 154, bound: 'exact' }],
    ['1 applicant', { count: 1, bound: 'exact' }],
    ['1,204 applicants', { count: 1204, bound: 'exact' }],
    ['Over 200 applicants', { count: 200, bound: 'min' }],
    ['\n   Be among the first 25 applicants\n  ', { count: 25, bound: 'max' }],
  ])('%j', (input, expected) => {
    expect(parseApplicants(input)).toEqual(expected);
  });

  it.each(['', 'Be an early applicant', 'Actively Hiring', null, undefined])('returns null for %j', (input) => {
    expect(parseApplicants(input)).toBeNull();
  });
});

describe('detectRemoteSignal (Spec 1701 §5.6)', () => {
  it.each([
    ['Remote'],
    ['Remoto - Brasil'],
    ['Remota'],
    ['Télétravail'],
    ['Teletravail possible'],
    ['Teletrabajo'],
    ['Homeoffice'],
    ['Home-Office, Berlin'],
    ['Work from home'],
    ['WFH'],
    ['Telecommute'],
    ['Telework'],
    ['Fully remote'],
    ['100% remote'],
    ['Remote Support Engineer (Remote)'],
  ])('positive: %j', (field) => {
    expect(detectRemoteSignal(field)).toBe(true);
  });

  it.each([
    ['Remote Sensing Analyst'],
    ['Remote Control Technician'],
    ['Remote Support Engineer'],
    ['Home Office, Dallas'],
    ['Not remote'],
    ['No remote work'],
    ['Non-remote role'],
    ['Remoteness Analyst'],
    [''],
  ])('negative: %j', (field) => {
    expect(detectRemoteSignal(field)).toBe(false);
  });

  it('checks every field and tolerates nullish ones', () => {
    expect(detectRemoteSignal(null, undefined, 'Seattle, WA')).toBe(false);
    expect(detectRemoteSignal('Engineer', 'Remote')).toBe(true);
    expect(detectRemoteSignal()).toBe(false);
  });
});

describe('isJobRemote', () => {
  it('reads the title and location only; the description argument is ignored', () => {
    expect(isJobRemote('Engineer', 'Our team is fully remote', 'Seattle, WA')).toBe(false);
    expect(isJobRemote('Engineer', '', 'Remote')).toBe(true);
    expect(isJobRemote('Remote Sensing Analyst', '', 'Austin, TX')).toBe(false);
  });

  it('{ legacy: true } restores the old substring test over all three', () => {
    expect(isJobRemote('Remote Sensing Analyst', '', 'Austin, TX', { legacy: true })).toBe(true);
    expect(isJobRemote('Engineer', 'wfh ok', 'Seattle, WA', { legacy: true })).toBe(true);
  });
});

describe('criteria helpers', () => {
  it('parseCriteria maps lower-cased subheaders to collapsed values', () => {
    const { $, el } = criteria();
    expect(parseCriteria($, el)).toEqual({
      'seniority level': 'Internship',
      'employment type': 'Full-time',
      'job function': 'Other',
      industries: 'Consumer Services',
    });
  });

  it('parseJobType reads only "Employment type" (regression: not INTERNSHIP or OTHER)', () => {
    const { $, el } = criteria();
    expect(parseJobType($, el)).toEqual([JobType.FULL_TIME]);
  });

  it('parseJobType({ allCriteria: true }) keeps the old read of every criterion', () => {
    const { $, el } = criteria();
    const all = parseJobType($, el, { allCriteria: true });
    expect(all).toEqual(expect.arrayContaining([JobType.INTERNSHIP, JobType.FULL_TIME, JobType.OTHER]));
  });

  it('parseJobLevel and parseCompanyIndustry are unchanged', () => {
    const { $, el } = criteria();
    expect(parseJobLevel($, el)).toBe('Internship');
    expect(parseCompanyIndustry($, el)).toBe('Consumer Services');
  });

  it('jobTypeFromEmploymentType resolves the LinkedIn employment labels', () => {
    expect(jobTypeFromEmploymentType('Full-time')).toBe(JobType.FULL_TIME);
    expect(jobTypeFromEmploymentType('Part-time')).toBe(JobType.PART_TIME);
    expect(jobTypeFromEmploymentType('Contract')).toBe(JobType.CONTRACT);
    expect(jobTypeFromEmploymentType('Temporary')).toBe(JobType.TEMPORARY);
    expect(jobTypeFromEmploymentType('Internship')).toBe(JobType.INTERNSHIP);
    expect(jobTypeFromEmploymentType('')).toBeNull();
    expect(jobTypeFromEmploymentType(undefined)).toBeNull();
  });

  it('jobTypeCode is unchanged', () => {
    expect(jobTypeCode(JobType.FULL_TIME)).toBe('F');
    expect(jobTypeCode(JobType.INTERNSHIP)).toBe('I');
  });
});

describe('identity helpers (Spec 1701 §5.1)', () => {
  it('extractLinkedInJobId prefers the urn, then the href digits, else null', () => {
    const $ = cheerio.load(`
      <li id="a"><div class="base-search-card" data-entity-urn="urn:li:jobPosting:4419969671"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/x-at-y-1111111111?position=1"></a></div></li>
      <li id="b"><div class="base-search-card"><a class="base-card__full-link" href="https://ca.linkedin.com/jobs/view/senior-engineer-%E2%80%93-go-at-acme-4470016722?position=2&amp;trackingId=a"></a></div></li>
      <li id="c"><div class="base-search-card"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/mystery-role?position=3"></a></div></li>
      <li id="d"><div class="base-search-card" data-entity-urn="urn:li:company:42"></div></li>`);
    expect(extractLinkedInJobId($('#a'))).toBe('4419969671');
    expect(extractLinkedInJobId($('#b'))).toBe('4470016722');
    expect(extractLinkedInJobId($('#c'))).toBeNull();
    expect(extractLinkedInJobId($('#d'))).toBeNull();
  });

  it('jobIdFromHref needs at least six trailing digits at the end of the path', () => {
    expect(jobIdFromHref('https://www.linkedin.com/jobs/view/4471641260')).toBe('4471641260');
    expect(jobIdFromHref('https://www.linkedin.com/jobs/view/data-engineer-2024-at-globex-4471641260/')).toBe('4471641260');
    expect(jobIdFromHref('https://www.linkedin.com/jobs/view/engineer-2024')).toBeNull();
    expect(jobIdFromHref(null)).toBeNull();
  });

  it('normalizeCompanyUrl drops ?trk and the regional subdomain', () => {
    expect(normalizeCompanyUrl('https://ca.linkedin.com/company/acme-robotics?trk=public_jobs')).toBe(
      'https://www.linkedin.com/company/acme-robotics',
    );
    expect(normalizeCompanyUrl('https://www.linkedin.com/company/globex/jobs')).toBe('https://www.linkedin.com/company/globex');
    expect(normalizeCompanyUrl('https://acme.example/about')).toBe('https://acme.example/about');
    expect(normalizeCompanyUrl('  ')).toBeNull();
    expect(normalizeCompanyUrl(null)).toBeNull();
  });

  it('companySlugFromUrl refuses a dot-only or odd slug', () => {
    expect(companySlugFromUrl('https://www.linkedin.com/company/clear-by-alclear-llc?trk=x')).toBe('clear-by-alclear-llc');
    expect(companySlugFromUrl('https://www.linkedin.com/company/..')).toBeNull();
    expect(companySlugFromUrl('https://evil.example/company/acme')).toBeNull();
    expect(companySlugFromUrl('https://notlinkedin.com/company/acme')).toBeNull();
  });
});

describe('URL helpers', () => {
  it('licdnMediaUrl accepts only media.licdn.com', () => {
    expect(licdnMediaUrl('https://media.licdn.com/dms/image/v2/X/company-logo_100_100/0/1/x?e=1&v=beta')).toMatch(
      /^https:\/\/media\.licdn\.com\//,
    );
    expect(licdnMediaUrl('https://static.licdn.com/aero-v1/sc/h/ghost')).toBeNull();
    expect(licdnMediaUrl('https://media.licdn.com.evil.example/x')).toBeNull();
    expect(licdnMediaUrl('javascript:alert(1)')).toBeNull();
    expect(licdnMediaUrl(undefined)).toBeNull();
  });

  it('externalHttpUrl refuses linkedin.com and non-http schemes', () => {
    expect(externalHttpUrl('http://clearme.com')).toBe('http://clearme.com');
    expect(externalHttpUrl('https://www.linkedin.com/company/x')).toBeNull();
    expect(externalHttpUrl('https://ca.linkedin.com/x')).toBeNull();
    expect(externalHttpUrl('ftp://acme.example')).toBeNull();
    expect(externalHttpUrl('not a url')).toBeNull();
  });

  it('unwrapLinkedInRedirect reads the url parameter of a redirect wrapper', () => {
    expect(
      unwrapLinkedInRedirect('https://www.linkedin.com/redir/redirect?url=http%3A%2F%2Fclearme%2Ecom&urlhash=IxqF&trk=about_website'),
    ).toBe('http://clearme.com');
    expect(unwrapLinkedInRedirect('http://acme.example')).toBe('http://acme.example');
    expect(unwrapLinkedInRedirect('https://www.linkedin.com/redir/redirect?urlhash=x')).toBeNull();
    expect(unwrapLinkedInRedirect('')).toBeNull();
  });
});

describe('block detection (Spec 1701 §7)', () => {
  it('HTTP 999 on an error or a response is a block', () => {
    expect(linkedInBlockReason({ response: { status: 999 } })).toBe('HTTP 999');
    expect(linkedInBlockReason({ status: 999 })).toBe('HTTP 999');
    expect(linkedInBlockReason(new Error('Request failed with status code 999'))).toBe('HTTP 999');
  });

  it('a final URL on a sign-in wall is a block', () => {
    for (const path of ['authwall?trk=x', 'login?session_redirect=y', 'signup', 'uas/login', 'checkpoint/lg/login']) {
      expect(linkedInBlockReason({ status: 200, request: { res: { responseUrl: `https://www.linkedin.com/${path}` } } })).toBe(
        'authwall',
      );
    }
    expect(
      linkedInBlockReason({ response: { status: 200, request: { res: { responseUrl: 'https://www.linkedin.com/authwall' } } } }),
    ).toBe('authwall');
  });

  it('ordinary pages, other errors and look-alike slugs are not blocks', () => {
    expect(linkedInBlockReason({ status: 200, request: { res: { responseUrl: 'https://www.linkedin.com/jobs/view/123456' } } })).toBeNull();
    expect(linkedInBlockReason({ status: 200, request: { res: { responseUrl: 'https://www.linkedin.com/company/login-systems' } } })).toBeNull();
    expect(linkedInBlockReason(new Error('Request failed with status code 429'))).toBeNull();
    expect(linkedInBlockReason({ response: { status: 403 } })).toBeNull();
    expect(linkedInBlockReason(null)).toBeNull();
    expect(linkedInBlockReason('999')).toBeNull();
  });

  it('linkedInBlockDiagnostics reports `blocked` with where it happened', () => {
    const diag = linkedInBlockDiagnostics({ response: { status: 999 } }, 'start=20');
    expect(diag?.reason).toBe('blocked');
    expect(diag?.detail).toBe('linkedin HTTP 999 at start=20');
    expect(linkedInBlockDiagnostics(new Error('boom'), 'start=0')).toBeNull();
  });
});

describe('switches', () => {
  it('resolveLinkedInLegacy is all-off by default', () => {
    expect(resolveLinkedInLegacy({})).toEqual({ pagination: false, ids: false, pay: false, detail: false, remote: false });
  });

  it('resolveLinkedInLegacy reads a comma/space list, or all', () => {
    expect(resolveLinkedInLegacy({ [LINKEDIN_LEGACY_ENV]: 'pagination, IDS pay' })).toEqual({
      pagination: true,
      ids: true,
      pay: true,
      detail: false,
      remote: false,
    });
    for (const all of ['all', 'true', '1', 'on']) {
      expect(Object.values(resolveLinkedInLegacy({ [LINKEDIN_LEGACY_ENV]: all })).every(Boolean)).toBe(true);
    }
    expect(resolveLinkedInLegacy({ [LINKEDIN_LEGACY_ENV]: 'nonsense' }).ids).toBe(false);
  });

  it('resolveFetchCompanyDetails: the input wins, then the env var, default off', () => {
    expect(resolveFetchCompanyDetails({}, {})).toBe(false);
    expect(resolveFetchCompanyDetails({}, { [LINKEDIN_FETCH_COMPANY_DETAILS_ENV]: 'true' })).toBe(true);
    expect(resolveFetchCompanyDetails({ linkedinFetchCompanyDetails: false }, { [LINKEDIN_FETCH_COMPANY_DETAILS_ENV]: '1' })).toBe(
      false,
    );
    expect(resolveFetchCompanyDetails({ linkedinFetchCompanyDetails: true }, {})).toBe(true);
  });
});
