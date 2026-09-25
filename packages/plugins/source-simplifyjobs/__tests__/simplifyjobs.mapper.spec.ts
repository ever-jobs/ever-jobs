import { DatePostedBasis, DatePostedPrecision, JobType, Site } from '@ever-jobs/models';
import {
  detectAtsType,
  employmentTypeOf,
  isDayGranular,
  jobTypesOf,
  mapRowToJobPost,
  normalizeCategory,
  normalizeFeedLocation,
  normalizeSponsorship,
  postedTimeOf,
} from '../src/simplifyjobs.mapper';
import { SimplifyRow } from '../src/simplifyjobs.types';

const SITE: Site = Site.SIMPLIFYJOBS;
const NOW_MS = Date.UTC(2026, 8, 24, 20, 0, 0); // 2026-09-24T20:00:00Z
const MIDNIGHT_S = Date.UTC(2026, 8, 24) / 1000;

function row(overrides: Partial<SimplifyRow> = {}): SimplifyRow {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    feed: 'internships',
    title: 'Software Engineering Intern',
    companyName: 'Acme Robotics',
    companyUrl: 'https://simplify.jobs/c/Acme-Robotics',
    category: 'Software',
    terms: ['Summer 2027'],
    datePosted: MIDNIGHT_S,
    dateUpdated: MIDNIGHT_S + 3600,
    url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/2001',
    locations: ['Toronto, ON, Canada'],
    sponsorship: null,
    ...overrides,
  };
}

describe('normalizeFeedLocation (Spec 1694)', () => {
  it.each([
    ['NYC', 'New York, NY'],
    ['nyc', 'New York, NY'],
    [' SF ', 'San Francisco, CA'],
    ['SF Bay Area', 'San Francisco Bay Area, CA'],
    ['Bay Area', 'San Francisco Bay Area, CA'],
    ['DC', 'Washington, DC'],
    ['Kanata, Ottawa, ON, Canada', 'Ottawa, ON, Canada'],
    ['Research Park, Austin, TX, USA', 'Austin, TX, USA'],
    ['Research Triangle, Durham, NC', 'Durham, NC'],
    ['Old Town, Downtown, Seattle, WA', 'Seattle, WA'],
  ])('rewrites %j to %j', (raw, expected) => {
    expect(normalizeFeedLocation(raw)).toBe(expected);
  });

  it.each([
    'Toronto, ON, Canada',
    'Austin, TX',
    'London, UK',
    'London, ON',
    'Cambridge, MA',
    'Bossier City, LA',
    'LA',
    'Remote in USA',
    'Halifax Regional Municipality, NS, Canada',
    'Dubai - United Arab Emirates',
    'Haifa, Israel, IL',
    'Chennai, TN, IN',
    'Singapore',
    'New York, NY, USA',
  ])('leaves %j alone', (raw) => {
    expect(normalizeFeedLocation(raw)).toBe(raw);
  });

  it('collapses whitespace and leaves labels with empty parts untouched', () => {
    expect(normalizeFeedLocation('  Austin,   TX ')).toBe('Austin, TX');
    expect(normalizeFeedLocation('Austin, , TX')).toBe('Austin, , TX');
  });
});

describe('normalizeCategory (Spec 1694)', () => {
  it.each([
    ['Software', 'Software'],
    ['Software Engineering', 'Software'],
    ['AI/ML/Data', 'AI/ML/Data'],
    ['Data Science, AI & Machine Learning', 'AI/ML/Data'],
    ['Quant', 'Quant'],
    ['Quantitative Finance', 'Quant'],
    ['Quantitative Data Science', 'Quant'],
    ['Hardware', 'Hardware'],
    ['Hardware Engineering', 'Hardware'],
    ['Product', 'Product'],
    ['Product Management', 'Product'],
    ['  Consulting  ', 'Consulting'],
    ['Maintenance', 'Maintenance'],
  ])('maps %j to %j', (raw, expected) => {
    expect(normalizeCategory(raw)).toBe(expected);
  });

  it('returns null for empty or non-string values', () => {
    expect(normalizeCategory('  ')).toBeNull();
    expect(normalizeCategory(undefined)).toBeNull();
    expect(normalizeCategory(7)).toBeNull();
  });
});

describe('detectAtsType (Spec 1694)', () => {
  it.each([
    ['https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/X_R1', 'workday'],
    ['https://wd3.myworkdaysite.com/recruiting/acme/Careers/job/X', 'workday'],
    ['https://boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://careers.acme.example/openings?gh_jid=4242', 'greenhouse'],
    ['https://jobs.lever.co/acme/abc', 'lever'],
    ['https://jobs.eu.lever.co/acme/abc', 'lever'],
    ['https://jobs.ashbyhq.com/acme/abc', 'ashby'],
    ['https://careers-acme.icims.com/jobs/1/job', 'icims'],
    ['https://jobs.smartrecruiters.com/Acme/1', 'smartrecruiters'],
    ['https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/job/1', 'oracle'],
    ['https://acme.taleo.net/careersection/2/jobdetail.ftl?job=1', 'taleo'],
    ['https://acme.eightfold.ai/careers/job/1', 'eightfold'],
    ['https://apply.workable.com/acme/j/1/', 'workable'],
    ['https://jobs.jobvite.com/acme/job/o1', 'jobvite'],
    ['https://career4.successfactors.com/career?company=acme', 'successfactors'],
    ['https://recruiting.ultipro.com/ACM1000/JobBoard/x', 'ukg'],
    ['https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=x', 'adp'],
    ['https://acme.applytojob.com/apply/abc', 'jazzhr'],
  ])('detects %s as %s', (url, ats) => {
    expect(detectAtsType(url)).toBe(ats);
  });

  it('returns null for an unknown host or an unparseable URL', () => {
    expect(detectAtsType('https://careers.acme.example/jobs/1')).toBeNull();
    expect(detectAtsType('https://notmyworkdayjobs.com.example/x')).toBeNull();
    expect(detectAtsType('not a url')).toBeNull();
  });
});

describe('normalizeSponsorship (Spec 1694)', () => {
  it.each([
    ['Offers Sponsorship', 'offered'],
    ['Does Not Offer Sponsorship', 'not_offered'],
    ['U.S. Citizenship is Required', 'citizenship_required'],
    ['  u.s. citizenship is required ', 'citizenship_required'],
    ['Other', null],
    ['', null],
    [undefined, null],
  ])('maps %j to %j', (raw, expected) => {
    expect(normalizeSponsorship(raw)).toBe(expected);
  });
});

describe('posted time (Spec 1694 / Spec 1696)', () => {
  it('reads a midnight-aligned value as a calendar day with no instant', () => {
    expect(isDayGranular(MIDNIGHT_S)).toBe(true);
    expect(postedTimeOf({ datePosted: MIDNIGHT_S }, NOW_MS)).toEqual({
      datePosted: '2026-09-24',
      datePostedAt: null,
      datePostedPrecision: DatePostedPrecision.DAY,
      datePostedBasis: DatePostedBasis.DATE,
    });
  });

  it('reads any other value as an exact instant in epoch SECONDS', () => {
    expect(isDayGranular(MIDNIGHT_S + 61)).toBe(false);
    expect(postedTimeOf({ datePosted: MIDNIGHT_S + 61 }, NOW_MS)).toEqual({
      datePosted: '2026-09-24',
      datePostedAt: '2026-09-24T00:01:01.000Z',
      datePostedPrecision: DatePostedPrecision.EXACT,
      datePostedBasis: DatePostedBasis.TIMESTAMP,
    });
  });

  it('gives nothing for a missing or non-positive value', () => {
    for (const datePosted of [null, 0, -1, Number.NaN]) {
      expect(postedTimeOf({ datePosted }, NOW_MS).datePosted).toBeNull();
    }
  });

  it('keeps the date of a far-future value but claims no precision', () => {
    const future = MIDNIGHT_S + 10 * 86400 + 5;
    expect(postedTimeOf({ datePosted: future }, NOW_MS)).toMatchObject({
      datePosted: '2026-10-04',
      datePostedPrecision: null,
    });
  });
});

describe('job type and employment type (Spec 1694)', () => {
  it('marks new-grad rows full-time and internships as internships (+ summer)', () => {
    expect(jobTypesOf({ feed: 'newgrad', terms: [] })).toEqual([JobType.FULL_TIME]);
    expect(jobTypesOf({ feed: 'internships', terms: ['Summer 2027'] })).toEqual([JobType.INTERNSHIP, JobType.SUMMER]);
    expect(jobTypesOf({ feed: 'internships', terms: ['Winter 2027', 'Spring 2027'] })).toEqual([JobType.INTERNSHIP]);
  });

  it('describes the terms (N/A already removed at compaction)', () => {
    expect(employmentTypeOf({ feed: 'internships', terms: ['Winter 2027', 'Spring 2027'] })).toBe(
      'Internship · Winter 2027, Spring 2027',
    );
    expect(employmentTypeOf({ feed: 'internships', terms: [] })).toBe('Internship');
    expect(employmentTypeOf({ feed: 'newgrad', terms: [] })).toBe('Full-time (new grad)');
  });
});

describe('mapRowToJobPost (Spec 1694)', () => {
  it('maps every field of an internship row', () => {
    const job = mapRowToJobPost(row(), NOW_MS, SITE);
    expect(job).toMatchObject({
      id: 'simplifyjobs-11111111-2222-4333-8444-555555555555',
      site: SITE,
      title: 'Software Engineering Intern',
      companyName: 'Acme Robotics',
      companyUrl: 'https://simplify.jobs/c/Acme-Robotics',
      jobUrl: 'https://job-boards.greenhouse.io/acmerobotics/jobs/2001',
      jobUrlDirect: 'https://job-boards.greenhouse.io/acmerobotics/jobs/2001',
      applyUrl: 'https://job-boards.greenhouse.io/acmerobotics/jobs/2001',
      location: { city: 'Toronto', state: 'ON', country: 'Canada' },
      isRemote: false,
      datePosted: '2026-09-24',
      datePostedPrecision: DatePostedPrecision.DAY,
      jobType: [JobType.INTERNSHIP, JobType.SUMMER],
      jobLevel: 'Internship',
      employmentType: 'Internship · Summer 2027',
      jobFunction: 'Software',
      atsType: 'greenhouse',
      description: null,
      emails: null,
      compensation: null,
      skills: null,
    });
    expect(job.datePostedAt).toBeUndefined();
  });

  it('maps a new-grad row as full-time, entry level', () => {
    const job = mapRowToJobPost(row({ feed: 'newgrad', terms: [], datePosted: MIDNIGHT_S + 5000 }), NOW_MS, SITE);
    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    expect(job.jobLevel).toBe('Entry level');
    expect(job.employmentType).toBe('Full-time (new grad)');
    expect(job.datePostedAt).toBe('2026-09-24T01:23:20.000Z');
  });

  it.each([
    ['Cambridge, UK', { city: 'Cambridge', country: 'United Kingdom' }],
    ['Cambridge, MA', { city: 'Cambridge', state: 'MA' }],
    ['Birmingham, AL', { city: 'Birmingham', state: 'AL' }],
    ['Birmingham, UK', { city: 'Birmingham', country: 'United Kingdom' }],
    ['London, ON, Canada', { city: 'London', state: 'ON', country: 'Canada' }],
    ['Dubai - United Arab Emirates', { city: 'Dubai', country: 'United Arab Emirates' }],
  ])('keeps the parser reading of %j', (label, expected) => {
    expect(mapRowToJobPost(row({ locations: [label] }), NOW_MS, SITE).location).toMatchObject(expected);
  });

  it.each([
    ['Research Park, Austin, TX, USA', { city: 'Austin', state: 'TX', text: 'Research Park, Austin, TX, USA' }],
    ['NYC', { city: 'New York', state: 'NY', text: 'NYC' }],
    ['SF', { city: 'San Francisco', state: 'CA', text: 'SF' }],
    ['Kanata, Ottawa, ON, Canada', { city: 'Ottawa', state: 'ON', country: 'Canada', text: 'Kanata, Ottawa, ON, Canada' }],
    ['Research Triangle, Durham, NC', { city: 'Durham', state: 'NC', text: 'Research Triangle, Durham, NC' }],
  ])('rewrites %j before parsing and keeps the raw label as text', (label, expected) => {
    const job = mapRowToJobPost(row({ locations: [label] }), NOW_MS, SITE);
    expect(job.location).toMatchObject(expected);
    expect(job.locations?.[0]).toMatchObject(expected);
  });

  it('marks a remote label remote with its country', () => {
    const job = mapRowToJobPost(row({ locations: ['Remote in USA'] }), NOW_MS, SITE);
    expect(job.isRemote).toBe(true);
    expect(job.workFromHomeType).toBe('Remote');
    expect(job.location).toMatchObject({ country: 'United States' });
  });

  it('keeps one entry per site for a multi-location row', () => {
    const job = mapRowToJobPost(row({ locations: ['Austin, TX', 'NYC', 'Remote in USA'] }), NOW_MS, SITE);
    expect(job.locations).toHaveLength(3);
    expect(job.locations?.[1]).toMatchObject({ city: 'New York', state: 'NY', text: 'NYC' });
    expect(job.isRemote).toBe(true);
  });

  it('omits locations for a row without any', () => {
    const job = mapRowToJobPost(row({ locations: [] }), NOW_MS, SITE);
    expect(job.location).toBeNull();
    expect(job.locations).toBeUndefined();
  });

  it('never synthesises a description', () => {
    const job = mapRowToJobPost(row({ category: 'AI/ML/Data', sponsorship: 'offered' }), NOW_MS, SITE);
    expect(job.description).toBeNull();
  });
});
