import 'reflect-metadata';
import { DatePostedBasis, DatePostedPrecision, JobPostDto } from '@ever-jobs/models';
import { SearchCommand, postedAtLabel } from '../src/commands/search.command';

/**
 * Spec 1696 — the CLI's CSV and table output carry the posting-time detail
 * (`datePostedAt`, `datePostedPrecision`, `datePostedBasis`), appended after
 * the existing columns so no earlier column moves.
 */

/** The CSV header before Spec 1696, in order. */
const LEGACY_CSV_HEADERS = [
  'id', 'site', 'title', 'companyName', 'location', 'jobUrl',
  'datePosted', 'jobType', 'isRemote', 'minAmount', 'maxAmount',
  'currency', 'interval', 'description',
];

function detailed(): JobPostDto {
  return new JobPostDto({
    id: 'li-1',
    site: 'linkedin',
    title: 'Engineer',
    companyName: 'Acme',
    jobUrl: 'https://example.com/li-1',
    datePosted: '2026-09-24',
    datePostedAt: '2026-09-24T19:34:00.000Z',
    datePostedPrecision: DatePostedPrecision.MINUTE,
    datePostedBasis: DatePostedBasis.RELATIVE,
    isRemote: true,
  });
}

function dateOnly(): JobPostDto {
  return new JobPostDto({
    id: 'lever-1',
    site: 'lever',
    title: 'Operator',
    companyName: 'Acme',
    jobUrl: 'https://example.com/lever-1',
    datePosted: '2026-09-20',
    isRemote: false,
  });
}

async function render(jobs: JobPostDto[], format: string): Promise<string> {
  const jobsService = { searchJobs: jest.fn().mockResolvedValue(jobs) };
  const analytics = { analyze: jest.fn(), analyzeCompanies: jest.fn().mockReturnValue([]) };
  const cmd = new SearchCommand(jobsService as any, analytics as any);
  await cmd.run([], { searchTerm: 'engineer', format } as any);
  return stdout.mock.calls.map((c) => String(c[0])).join('');
}

let stdout: jest.SpyInstance;
let stderr: jest.SpyInstance;

beforeEach(() => {
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
});

describe('search --format csv (Spec 1696)', () => {
  it('appends the three columns after the pre-existing ones', async () => {
    const [header] = (await render([dateOnly()], 'csv')).split('\n');
    const columns = header.split(',');
    expect(columns.slice(0, LEGACY_CSV_HEADERS.length)).toEqual(LEGACY_CSV_HEADERS);
    expect(columns.slice(LEGACY_CSV_HEADERS.length)).toEqual(['datePostedAt', 'datePostedPrecision', 'datePostedBasis']);
  });

  it('fills them from the job and leaves them empty for a date-only job', async () => {
    const [, first, second] = (await render([detailed(), dateOnly()], 'csv')).trimEnd().split('\n');
    const a = first.split(',');
    const b = second.split(',');
    expect(a).toHaveLength(LEGACY_CSV_HEADERS.length + 3);
    expect(b).toHaveLength(LEGACY_CSV_HEADERS.length + 3);
    expect(a.slice(-3)).toEqual(['2026-09-24T19:34:00.000Z', 'minute', 'relative']);
    expect(b.slice(-3)).toEqual(['', '', '']);
    // The pre-existing columns keep their positions and values.
    expect(a[LEGACY_CSV_HEADERS.indexOf('datePosted')]).toBe('2026-09-24');
    expect(b[LEGACY_CSV_HEADERS.indexOf('datePosted')]).toBe('2026-09-20');
    expect(a[LEGACY_CSV_HEADERS.indexOf('isRemote')]).toBe('true');
  });
});

describe('search --format table (Spec 1696)', () => {
  it('appends a "Posted at (UTC)" column and keeps the original ones', async () => {
    const [header, , first, second] = (await render([detailed(), dateOnly()], 'table')).split('\n');
    const headerCells = header.split(' │ ').map((c) => c.trim());
    expect(headerCells).toEqual(['Site', 'Title', 'Company', 'Location', 'Posted', 'Remote', 'Posted at (UTC)']);

    const a = first.split(' │ ').map((c) => c.trim());
    const b = second.split(' │ ').map((c) => c.trim());
    expect(a).toEqual(['linkedin', 'Engineer', 'Acme', '', '2026-09-24', 'Yes', '~2026-09-24 19:34']);
    expect(b).toEqual(['lever', 'Operator', 'Acme', '', '2026-09-20', 'No', '']);
  });
});

describe('postedAtLabel (Spec 1696)', () => {
  it('prints the instant to the minute in UTC', () => {
    expect(postedAtLabel({ datePostedAt: '2026-09-24T19:34:56.789Z', datePostedBasis: DatePostedBasis.TIMESTAMP })).toBe(
      '2026-09-24 19:34',
    );
  });

  it('marks an estimate from an age label with ~', () => {
    expect(postedAtLabel({ datePostedAt: '2026-09-24T18:00:00.000Z', datePostedBasis: DatePostedBasis.RELATIVE })).toBe(
      '~2026-09-24 18:00',
    );
  });

  it.each([
    ['absent', {}],
    ['null', { datePostedAt: null }],
    ['unparseable', { datePostedAt: 'yesterday' }],
  ])('is blank when the instant is %s', (_label, job) => {
    expect(postedAtLabel(job)).toBe('');
  });
});
