import axios from 'axios';
import { getJobDetails, postedTimeDetail, searchJobs } from '../src/tools';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

/**
 * Spec 1696 — the posting-time detail (`datePostedAt`, `datePostedPrecision`,
 * `datePostedBasis`) reaches the MCP tools as `date_posted_at`,
 * `date_posted_precision` and `date_posted_basis`, present only when the API
 * sent them, so a job without the detail keeps exactly its previous shape.
 */

const createMock = axios.create as unknown as jest.Mock;

function mockClient(data: unknown) {
  const client = { post: jest.fn().mockResolvedValue({ data }), get: jest.fn().mockResolvedValue({ data }) };
  createMock.mockReturnValue(client);
  return client;
}

const DETAILED = {
  id: 'li-1',
  title: 'Engineer',
  companyName: 'Acme',
  jobUrl: 'https://example.com/li-1',
  site: 'linkedin',
  datePosted: '2026-09-24',
  datePostedAt: '2026-09-24T19:34:00.000Z',
  datePostedPrecision: 'minute',
  datePostedBasis: 'relative',
};

const DATE_ONLY = {
  id: 'lever-1',
  title: 'Operator',
  companyName: 'Acme',
  jobUrl: 'https://example.com/lever-1',
  site: 'lever',
  datePosted: '2026-09-20',
};

/** The keys every job result carried before Spec 1696, in order. */
const LEGACY_JOB_KEYS = [
  'id', 'title', 'company', 'location', 'url', 'description', 'date_posted',
  'is_remote', 'source', 'salary', 'department',
];

beforeEach(() => {
  createMock.mockReset();
});

describe('postedTimeDetail (Spec 1696)', () => {
  it('maps the camelCase API fields to snake_case', () => {
    expect(postedTimeDetail(DETAILED)).toEqual({
      date_posted_at: '2026-09-24T19:34:00.000Z',
      date_posted_precision: 'minute',
      date_posted_basis: 'relative',
    });
  });

  it('also reads a snake_case API response', () => {
    expect(
      postedTimeDetail({ date_posted_at: '2026-09-24T19:00:00.000Z', date_posted_precision: 'hour', date_posted_basis: 'relative' }),
    ).toEqual({
      date_posted_at: '2026-09-24T19:00:00.000Z',
      date_posted_precision: 'hour',
      date_posted_basis: 'relative',
    });
  });

  it('carries a precision without an instant (a day-precision row)', () => {
    expect(postedTimeDetail({ datePostedPrecision: 'day', datePostedBasis: 'date' })).toEqual({
      date_posted_precision: 'day',
      date_posted_basis: 'date',
    });
  });

  it.each([
    ['absent', {}],
    ['null', { datePostedAt: null, datePostedPrecision: null, datePostedBasis: null }],
    ['blank', { datePostedAt: '  ', datePostedPrecision: '', datePostedBasis: '' }],
    ['not a string', { datePostedAt: 1790280000000, datePostedPrecision: 3, datePostedBasis: true }],
  ])('adds no key when the values are %s', (_label, job) => {
    expect(postedTimeDetail(job)).toEqual({});
  });

  it('tolerates a non-object job', () => {
    expect(postedTimeDetail(null)).toEqual({});
    expect(postedTimeDetail('x')).toEqual({});
  });
});

describe('search_jobs / get_job_details carry the detail (Spec 1696)', () => {
  it('search_jobs: detail keys right after date_posted, and a date-only job keeps its old shape', async () => {
    mockClient({ jobs: [DETAILED, DATE_ONLY] });
    const res = await searchJobs({ query: 'engineer' });
    const [detailed, dateOnly] = res.jobs;

    expect(detailed).toMatchObject({
      date_posted: '2026-09-24',
      date_posted_at: '2026-09-24T19:34:00.000Z',
      date_posted_precision: 'minute',
      date_posted_basis: 'relative',
    });
    const keys = Object.keys(detailed);
    expect(keys.slice(keys.indexOf('date_posted'), keys.indexOf('date_posted') + 4)).toEqual([
      'date_posted', 'date_posted_at', 'date_posted_precision', 'date_posted_basis',
    ]);

    expect(Object.keys(dateOnly)).toEqual(LEGACY_JOB_KEYS);
    expect(dateOnly.date_posted).toBe('2026-09-20');
  });

  it('get_job_details: carries the detail, and omits it for a date-only job', async () => {
    mockClient(DETAILED);
    expect(await getJobDetails({ jobId: 'li-1' })).toMatchObject({
      date_posted: '2026-09-24',
      date_posted_at: '2026-09-24T19:34:00.000Z',
      date_posted_precision: 'minute',
      date_posted_basis: 'relative',
    });

    mockClient(DATE_ONLY);
    const plain = await getJobDetails({ jobId: 'lever-1' });
    expect(plain).not.toHaveProperty('date_posted_at');
    expect(plain).not.toHaveProperty('date_posted_precision');
    expect(plain).not.toHaveProperty('date_posted_basis');
  });
});
