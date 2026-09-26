import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { CompensationInterval, DescriptionFormat, JobType, Site } from '@ever-jobs/models';
import {
  applyDetails,
  bdjobsJobId,
  bdjobsLocationLabel,
  buildDescriptionHtml,
  buildLocation,
  detailSalary,
  formatDescription,
  interpretDetailBody,
  interpretSearchBody,
  isoDateOnly,
  mapJobType,
  mapListItem,
  mapWorkplace,
  mergeEmails,
  parseBdjobsCalendarDate,
  parseBdjobsSalary,
  parseMonthDayYear,
  publishInstantMs,
  resolveBdjobsMode,
  sectionHtml,
  splitSkills,
} from '../src/bdjobs.parse';
import { BdjobsDetail, BdjobsListItem } from '../src/bdjobs.types';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const json = <T>(name: string): T => JSON.parse(read(name)) as T;

const PAGE1 = json<{ data: BdjobsListItem[]; premiumData: BdjobsListItem[] }>('bdjobs-search-page1.json');
const DETAILS = json<{ data: BdjobsDetail[] }>('bdjobs-details.json');
const item = (id: string): BdjobsListItem =>
  JSON.parse(JSON.stringify(PAGE1.data.find((row) => row.Jobid === id)));
const detail = (): BdjobsDetail => JSON.parse(JSON.stringify(DETAILS.data[0]));

/** Spec 1711 — pure mapping helpers for the bdjobs.com JSON API. */
describe('bdjobs.parse — Spec 1711', () => {
  describe('parseBdjobsSalary', () => {
    it.each([
      ['Tk. 35000 - 50000 (Monthly)', CompensationInterval.MONTHLY, 35000, 50000],
      ['Tk. 15000 (Monthly)', CompensationInterval.MONTHLY, 15000, 15000],
      ['Tk. 1,20,000 - 1,50,000 (Monthly)', CompensationInterval.MONTHLY, 120000, 150000],
      ['Tk. 600000 (Yearly)', CompensationInterval.YEARLY, 600000, 600000],
      ['tk 500 - 700 (daily)', CompensationInterval.DAILY, 500, 700],
      ['Tk. 50000 - 35000 (Monthly)', CompensationInterval.MONTHLY, 35000, 50000],
    ])('%s parses', (text, interval, min, max) => {
      expect(parseBdjobsSalary(text)).toEqual({ interval, minAmount: min, maxAmount: max });
    });

    it.each([['--'], [''], ['Negotiable'], ['Tk. 0 (Monthly)'], ['Tk. 35000 - 50000'], ['$50000 (Yearly)'], [null], [42]])(
      '%p gives null',
      (text) => {
        expect(parseBdjobsSalary(text)).toBeNull();
      },
    );

    it('rejects an oversized string without scanning it', () => {
      expect(parseBdjobsSalary(`Tk. ${'1'.repeat(200)} (Monthly)`)).toBeNull();
    });
  });

  describe('detailSalary', () => {
    it('uses the details min/max when ShowSalary is 1', () => {
      const d = { ...detail(), JobSalaryRange: 'Negotiable', JobSalaryMinSalary: '40000', JobSalaryMaxSalary: '60000' };
      const list = parseBdjobsSalary('Tk. 35000 - 50000 (Monthly)');
      expect(detailSalary(d, list)).toEqual({ interval: CompensationInterval.MONTHLY, minAmount: 40000, maxAmount: 60000 });
    });

    it('does not invent an interval', () => {
      const d = { ...detail(), JobSalaryRange: 'Negotiable', JobSalaryMinSalary: '40000' };
      expect(detailSalary(d, null)).toBeNull();
    });

    it('ignores the figures when the salary is hidden', () => {
      const d = { ...detail(), ShowSalary: '0', JobSalaryRange: '--' };
      expect(detailSalary(d, parseBdjobsSalary('Tk. 1 (Monthly)'))).toBeNull();
    });
  });

  describe('dates', () => {
    const originalTz = process.env.TZ;
    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it.each(['Asia/Dhaka', 'America/Los_Angeles', 'Europe/Madrid'])(
      'parseMonthDayYear is time-zone safe under %s',
      (tz) => {
        process.env.TZ = tz;
        expect(parseMonthDayYear('Sep 23, 2026')).toBe('2026-09-23');
        expect(parseMonthDayYear('September 3, 2026')).toBe('2026-09-03');
        expect(parseBdjobsCalendarDate('20 Oct 2025')).toBe('2025-10-20');
        expect(parseBdjobsCalendarDate('05/10/2025')).toBe('2025-10-05');
      },
    );

    it.each([
      ['Oct 11, 2026', '2026-10-11'],
      ['20-Oct-2025', '2025-10-20'],
      ['20 October 2025', '2025-10-20'],
      ['2026-09-24T12:19:00Z', '2026-09-24'],
    ])('parseBdjobsCalendarDate(%s) = %s', (text, expected) => {
      expect(parseBdjobsCalendarDate(text)).toBe(expected);
    });

    it.each([['Feb 30, 2026'], ['Foo 1, 2026'], ['31/04/2026'], [''], ['yesterday'], [null]])(
      'impossible or unknown date %p gives null',
      (text) => {
        expect(parseMonthDayYear(text)).toBeNull();
        expect(parseBdjobsCalendarDate(text)).toBeNull();
      },
    );

    it('isoDateOnly keeps the ISO prefix verbatim and refuses free text', () => {
      expect(isoDateOnly('2026-09-23T23:59:00Z')).toBe('2026-09-23');
      expect(isoDateOnly('2026-09-23')).toBe('2026-09-23');
      expect(isoDateOnly('Sep 23, 2026')).toBeNull();
      expect(isoDateOnly('2026-13-01T00:00:00Z')).toBeNull();
    });

    it('publishInstantMs needs a time and a zone', () => {
      expect(publishInstantMs('2026-09-24T12:19:00Z')).toBe(Date.parse('2026-09-24T12:19:00Z'));
      expect(publishInstantMs('2026-09-24T12:19:00+06:00')).toBe(Date.parse('2026-09-24T06:19:00Z'));
      expect(publishInstantMs('2026-09-24')).toBeNull();
      expect(publishInstantMs('Sep 24, 2026')).toBeNull();
    });
  });

  describe('mapJobType', () => {
    it.each([
      ['FullTime', [JobType.FULL_TIME]],
      ['Contract', [JobType.CONTRACT]],
      ['Contractual', [JobType.CONTRACT]],
      ['Full Time', [JobType.FULL_TIME]],
      ['Part Time', [JobType.PART_TIME]],
      ['Internship', [JobType.INTERNSHIP]],
      ['Freelance', [JobType.CONTRACT]],
      ['Full Time, Contractual', [JobType.FULL_TIME, JobType.CONTRACT]],
    ])('%s → %p', (value, expected) => {
      expect(mapJobType(value)).toEqual(expected);
    });

    it.each([[''], ['Something else'], [null]])('%p → null', (value) => {
      expect(mapJobType(value)).toBeNull();
    });
  });

  describe('mapWorkplace', () => {
    it.each([
      ['Home', { isRemote: true, workFromHomeType: 'Remote' }],
      ['Work from home', { isRemote: true, workFromHomeType: 'Remote' }],
      ['Home,Office', { isRemote: false, workFromHomeType: 'Hybrid' }],
      ['Office', { isRemote: false, workFromHomeType: null }],
      ['', { isRemote: false, workFromHomeType: null }],
      [null, { isRemote: false, workFromHomeType: null }],
    ])('%p → %p', (value, expected) => {
      expect(mapWorkplace(value)).toEqual(expected);
    });
  });

  describe('location', () => {
    it('adds the country to a Dhaka neighbourhood label and keeps the raw text', () => {
      const loc = buildLocation('GULSHAN 1');
      expect(loc.location).toMatchObject({ city: 'GULSHAN 1', country: 'Bangladesh', text: 'GULSHAN 1' });
      expect(loc.locations).toHaveLength(1);
      expect(loc.countryCode).toBe('BD');
      expect(loc.location.displayLocation()).toBe('GULSHAN 1, Bangladesh');
    });

    it('treats "Anywhere in Bangladesh" as the country alone', () => {
      const loc = buildLocation('Anywhere in Bangladesh');
      expect(loc.location.city).toBeUndefined();
      expect(loc.location.country).toBe('Bangladesh');
      expect(loc.location.text).toBe('Anywhere in Bangladesh');
      expect(bdjobsLocationLabel('anywhere in bangladesh')).toBe('Bangladesh');
    });

    it('does not double the country suffix', () => {
      expect(bdjobsLocationLabel('Dhaka, Bangladesh')).toBe('Dhaka, Bangladesh');
      expect(buildLocation('Dhaka, Bangladesh').location).toMatchObject({ city: 'Dhaka', country: 'Bangladesh' });
    });

    it('an empty label is the country, with no text', () => {
      const loc = buildLocation('');
      expect(loc.location.country).toBe('Bangladesh');
      expect(loc.location.text).toBeUndefined();
      expect(loc.countryCode).toBe('BD');
    });

    it('uses the display string, never the enum value', () => {
      expect(buildLocation('Mirpur').location.displayLocation()).not.toMatch(/BANGLADESH/);
    });
  });

  describe('skills and emails', () => {
    it('splits, trims and de-duplicates case-insensitively', () => {
      expect(splitSkills('ASP.NET MVC, Microsoft Azure, JavaScript ES6, TypeScript', 'typescript, , SQL')).toEqual([
        'ASP.NET MVC',
        'Microsoft Azure',
        'JavaScript ES6',
        'TypeScript',
        'SQL',
      ]);
      expect(splitSkills('', null)).toBeNull();
    });

    it('merges email lists and single addresses without duplicates', () => {
      expect(mergeEmails(['hr@example.com'], 'HR@example.com', 'jobs@example.org', 'not an email')).toEqual([
        'hr@example.com',
        'jobs@example.org',
      ]);
      expect(mergeEmails(null, '')).toBeNull();
    });
  });

  describe('description', () => {
    it('keeps plain education lines as line breaks and escapes them', () => {
      expect(sectionHtml('BSc in CSE\nBBA & MBA\n')).toBe('<p>BSc in CSE<br>BBA &amp; MBA</p>');
      expect(sectionHtml('BSc\nBBA\n<ul><li>Any degree</li></ul>\ntail')).toBe('BSc<br>BBA<ul><li>Any degree</li></ul>tail');
      expect(sectionHtml('   ')).toBeNull();
    });

    it('stays linear on a long whitespace run', () => {
      const started = Date.now();
      sectionHtml(`a${' \n'.repeat(50_000)}b`);
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('assembles the sections in order and never uses the list education snippet as the body', () => {
      const html = buildDescriptionHtml(
        { ...detail(), EducationRequirements: '', JobOtherBenifits: '<ul><li>Festival bonus</li></ul>' },
        item('1537681'),
      )!;
      const order = ['Key Responsibilities', 'Context', 'Education', 'Experience', 'Additional requirements', 'Benefits', 'Deadline: Oct 11, 2026'];
      const positions = order.map((needle) => html.indexOf(needle));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it('returns null when every section is empty', () => {
      const empty: BdjobsDetail = { JobFound: 'True', Deadline: 'Oct 11, 2026' };
      expect(buildDescriptionHtml(empty, { Jobid: '1' })).toBeNull();
    });

    it('formats per descriptionFormat', () => {
      const html = '<h2>Experience</h2><ul><li>At least 4 years</li></ul>';
      expect(formatDescription(html, DescriptionFormat.HTML)).toBe(html);
      expect(formatDescription(html, DescriptionFormat.MARKDOWN)).not.toMatch(/<[a-z]/i);
      expect(formatDescription(html, DescriptionFormat.PLAIN)).not.toMatch(/<[a-z]/i);
      expect(formatDescription(html, undefined)).toBe(formatDescription(html, DescriptionFormat.MARKDOWN));
      expect(formatDescription(null, DescriptionFormat.HTML)).toBeNull();
    });
  });

  describe('mapListItem', () => {
    it('maps list fields and never uses jobDescription (an education snippet)', () => {
      const job = mapListItem(item('1537681'), { format: DescriptionFormat.MARKDOWN })!;
      expect(job).toMatchObject({
        id: '1537681',
        site: Site.BDJOBS,
        title: 'Assistant Manager - Real Estate (Sales & Marketing)',
        jobUrl: 'https://bdjobs.com/h/details/1537681',
        datePosted: '2026-09-24',
        countryCode: 'BD',
        jobType: [JobType.FULL_TIME],
        isRemote: false,
        experienceRange: '5 to 7 years',
        vacancyCount: 5,
        companyLogo: 'https://storage.googleapis.com/bdjobs/recruiter/logos/40039_2.png',
      });
      expect(job.compensation).toMatchObject({ currency: 'BDT', interval: 'monthly', minAmount: 35000, maxAmount: 50000 });
      expect(job.description).toContain('Competitive basic salary');
      expect(job.description).not.toContain('Bachelor');
      expect(job.listingType).toBeUndefined();
    });

    it('description is null without a jobContext', () => {
      expect(mapListItem(item('1536338'))!.description).toBeNull();
    });

    it('marks premium rows and keeps a Bangla-only title verbatim', () => {
      const premium = PAGE1.premiumData[0];
      const job = mapListItem(premium, { fromPremium: true })!;
      expect(job.listingType).toBe('premium');
      expect(job.title).toBe('ম্যানেজার (ডিজিটাল মার্কেটিং)');
      expect(mapListItem({ ...premium, AdType: '2' })!.listingType).toBe('premium');
    });

    it('falls back to the Bangla title, and skips a row with neither title', () => {
      expect(mapListItem({ ...item('1536338'), jobTitle: '  ', JobTitleBng: 'ডেভেলপার' })!.title).toBe('ডেভেলপার');
      expect(mapListItem({ ...item('1536338'), jobTitle: '', JobTitleBng: '' })).toBeNull();
      expect(mapListItem({ ...item('1536338'), Jobid: 'abc' })).toBeNull();
    });

    it('drops an NA experience and a zero vacancy count', () => {
      const job = mapListItem({ ...item('1536338'), experience: 'NA', Vacancies: 0 })!;
      expect(job.experienceRange).toBeUndefined();
      expect(job.vacancyCount).toBeNull();
    });

    it('"Anywhere in Bangladesh" with an empty workplace is not remote', () => {
      const job = mapListItem(item('1529470'))!;
      expect(job.isRemote).toBe(false);
      expect(job.workFromHomeType).toBeUndefined();
      expect(job.location?.country).toBe('Bangladesh');
    });
  });

  describe('applyDetails', () => {
    it('enriches the list job with the details payload', () => {
      const listItem = item('1536338');
      const job = mapListItem(listItem, { format: DescriptionFormat.HTML })!;
      applyDetails(job, listItem, detail(), DescriptionFormat.HTML);

      expect(job.skills).toEqual(['ASP.NET MVC', 'Microsoft Azure', 'JavaScript ES6', 'TypeScript']);
      expect(job.compensation).toMatchObject({ currency: 'BDT', interval: 'monthly', minAmount: 90000, maxAmount: 140000 });
      expect(job.vacancyCount).toBeNull();
      expect(job.companyAddresses).toBe('Claydon House, 1 Edison Road, Buckinghamshire, HP19 8TE');
      expect(job.companyUrl).toBeUndefined();
      expect(job.companyIndustry).toBeUndefined();
      expect(job.applyUrl).toBeUndefined();
      expect(job.description).toContain('<h2>Experience</h2>');
      expect(job.description).toContain('<p>Deadline: Oct 11, 2026</p>');
      expect(JSON.stringify(job)).not.toContain('0.0.0.0');
    });

    it('fills gaps from details: date, job type, workplace, company fields, apply URL, emails', () => {
      const listItem: BdjobsListItem = {
        ...item('1536338'),
        publishDate: null,
        JobType: '',
        WorkPlace: '',
        companyName: '',
        location: '',
      };
      const job = mapListItem(listItem)!;
      applyDetails(job, listItem, {
        ...detail(),
        JobVacancies: '3',
        CompanyWeb: 'www.example.com',
        CompanyBusiness: 'Software Company',
        CompanyHideAddress: 'True',
        ApplyURL: 'https://apply.example.com/job/1',
        ApplyEmail: 'hr@example.com',
        JobLocation: 'Uttara Sector 11',
        JobDescription: '<p>Send your CV to hr@example.com or careers@example.com</p>',
      });
      expect(job.datePosted).toBe('2026-09-23');
      expect(job.jobType).toEqual([JobType.CONTRACT]);
      expect(job.isRemote).toBe(true);
      expect(job.workFromHomeType).toBe('Remote');
      expect(job.companyName).toBe('Careberry Software Ltd');
      expect(job.companyUrl).toBe('https://www.example.com');
      expect(job.companyIndustry).toBe('Software Company');
      expect(job.companyAddresses).toBeUndefined();
      expect(job.applyUrl).toBe('https://apply.example.com/job/1');
      expect(job.vacancyCount).toBe(3);
      expect(job.location).toMatchObject({ city: 'Uttara Sector 11', country: 'Bangladesh' });
      expect(job.emails).toEqual(['hr@example.com', 'careers@example.com']);
    });

    it('keeps list values where both exist', () => {
      const listItem = item('1537681');
      const job = mapListItem(listItem)!;
      applyDetails(job, listItem, { ...detail(), JobTitle: 'Other', CompanyNameENG: 'Other Ltd', JobNature: 'Part Time', JobWorkPlace: 'Work from home' });
      expect(job.title).toBe('Assistant Manager - Real Estate (Sales & Marketing)');
      expect(job.companyName).toBe("Scion Asset Developer`s Ltd.");
      expect(job.jobType).toEqual([JobType.FULL_TIME]);
      expect(job.isRemote).toBe(false);
    });

    it('reads a short CompanyBusiness as the industry and a company profile as the description', () => {
      const listItem = item('1536338');
      const short = mapListItem(listItem)!;
      applyDetails(short, listItem, { ...detail(), CompanyBusiness: 'Apartment Sales.' });
      expect(short.companyIndustry).toBe('Apartment Sales.');
      expect(short.companyDescription).toBeUndefined();

      const profile = 'Started its journey in 2008.\n\nWe develop residential property across the country.';
      const long = mapListItem(listItem)!;
      applyDetails(long, listItem, { ...detail(), CompanyBusiness: profile });
      expect(long.companyIndustry).toBeUndefined();
      expect(long.companyDescription).toBe(profile);
    });

    it('refuses a non-http apply URL and a company site with spaces', () => {
      const listItem = item('1536338');
      const job = mapListItem(listItem)!;
      applyDetails(job, listItem, { ...detail(), ApplyURL: 'javascript:alert(1)', CompanyWeb: 'not a site' });
      expect(job.applyUrl).toBeUndefined();
      expect(job.companyUrl).toBeUndefined();
    });
  });

  describe('response interpretation', () => {
    it('reads a search page, premium rows first', () => {
      const page = interpretSearchBody(JSON.parse(read('bdjobs-search-page1.json')));
      expect(page.kind).toBe('ok');
      if (page.kind !== 'ok') return;
      expect(page.rows[0]).toMatchObject({ premium: true });
      expect(page.rows).toHaveLength(7);
      expect(page.totalPages).toBe(2);
      expect(page.totalRecords).toBe(8);
    });

    it('parses a JSON string body', () => {
      expect(interpretSearchBody(read('bdjobs-search-empty.json')).kind).toBe('ok');
    });

    it('turns the script-rendered shell into fetch_error', () => {
      const page = interpretSearchBody(read('bdjobs-spa-shell.html'));
      expect(page).toMatchObject({ kind: 'error', diagnostics: { reason: 'fetch_error', detail: 'unexpected non-JSON search response' } });
    });

    it('turns a challenge page into blocked', () => {
      const page = interpretSearchBody('<html><title>Just a moment...</title></html>');
      expect(page).toMatchObject({ kind: 'error', diagnostics: { reason: 'blocked' } });
    });

    it('turns JSON without a data array into unknown, naming the keys', () => {
      const page = interpretSearchBody({ message: 'Error', statuscode: '0' });
      expect(page).toMatchObject({ kind: 'error', diagnostics: { reason: 'unknown', detail: 'unexpected search response shape: message, statuscode' } });
    });

    it('judges details by shape, not statuscode', () => {
      expect(interpretDetailBody(JSON.parse(read('bdjobs-details.json'))).kind).toBe('ok');
      expect(interpretDetailBody(JSON.parse(read('bdjobs-details-notfound.json'))).kind).toBe('not_found');
      expect(interpretDetailBody({ data: [{ ...detail(), Closed: 1 }] }).kind).toBe('closed');
      expect(interpretDetailBody({ data: [] }).kind).toBe('not_found');
      expect(interpretDetailBody('<html></html>').kind).toBe('malformed');
    });

    it('bdjobsJobId accepts digits only', () => {
      expect(bdjobsJobId('1536338')).toBe('1536338');
      expect(bdjobsJobId(1536338)).toBe('1536338');
      expect(bdjobsJobId('15a')).toBeNull();
      expect(bdjobsJobId(null)).toBeNull();
    });
  });

  describe('resolveBdjobsMode', () => {
    it.each([
      [{}, 'api', null],
      [{ BDJOBS_MODE: 'api' }, 'api', null],
      [{ BDJOBS_MODE: 'HTML' }, 'html', null],
      [{ BDJOBS_MODE: 'legacy-html' }, 'html', null],
      [{ BDJOBS_STRATEGY: 'legacy-html' }, 'html', null],
      [{ BDJOBS_MODE: 'api', BDJOBS_STRATEGY: 'legacy-html' }, 'api', null],
      [{ BDJOBS_MODE: ' ', BDJOBS_STRATEGY: 'legacy-html' }, 'html', null],
      [{ BDJOBS_MODE: 'scrape' }, 'api', 'scrape'],
    ])('%p → %s', (env, mode, unrecognised) => {
      expect(resolveBdjobsMode(env as Record<string, string>)).toEqual({ mode, unrecognised });
    });
  });
});
