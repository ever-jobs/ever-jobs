import axios from 'axios';
import {
  DEFAULT_SOURCE_IDS,
  MCP_MAX_LOCATIONS,
  MCP_REQUEST_KEYS_ENV_VAR,
  buildSearchRequestBody,
  cleanList,
  searchJobs,
} from '../src/tools';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

/**
 * Spec 1700 — the MCP `search_jobs` tool forwards `locations` and the
 * exclusion filters, and a plain search body stays byte-identical.
 */

const createMock = axios.create as unknown as jest.Mock;

function mockClient(data: unknown) {
  const client = { post: jest.fn().mockResolvedValue({ data }), get: jest.fn() };
  createMock.mockReturnValue(client);
  return client;
}

let savedStyle: string | undefined;
beforeEach(() => {
  savedStyle = process.env[MCP_REQUEST_KEYS_ENV_VAR];
  delete process.env[MCP_REQUEST_KEYS_ENV_VAR];
  createMock.mockReset();
});
afterEach(() => {
  if (savedStyle === undefined) delete process.env[MCP_REQUEST_KEYS_ENV_VAR];
  else process.env[MCP_REQUEST_KEYS_ENV_VAR] = savedStyle;
});

describe('buildSearchRequestBody — Spec 1700', () => {
  it('adds nothing for a plain search', () => {
    expect(buildSearchRequestBody({ query: 'x', location: 'Berlin', source: 'linkedin' })).toEqual({
      searchTerm: 'x',
      location: 'Berlin',
      siteType: ['linkedin'],
      resultsWanted: 20,
      linkedinFetchDescription: true,
    });
  });

  it('falls back to the default source set when the caller names none', () => {
    const body = buildSearchRequestBody({ query: 'x' });
    expect(body.siteType).toEqual(DEFAULT_SOURCE_IDS);
    expect(DEFAULT_SOURCE_IDS.length).toBeGreaterThan(1);
    // Every default is a slugless board/remote/aggregator — the single-tenant
    // ATS and company sources would answer nothing.
    expect(DEFAULT_SOURCE_IDS).toContain('linkedin');
    expect(DEFAULT_SOURCE_IDS).not.toContain('ashby');
  });

  it('unions source and sources, dropping duplicates and blanks', () => {
    expect(
      buildSearchRequestBody({ query: 'x', source: 'linkedin', sources: ['indeed', 'linkedin', '  '] })
        .siteType,
    ).toEqual(['linkedin', 'indeed']);
  });

  it('honours an explicit sources list over the default', () => {
    expect(buildSearchRequestBody({ query: 'x', sources: ['glassdoor'] }).siteType).toEqual(['glassdoor']);
  });

  it('defaults linkedinFetchDescription to true and lets a caller opt out', () => {
    expect(buildSearchRequestBody({ query: 'x' }).linkedinFetchDescription).toBe(true);
    expect(buildSearchRequestBody({ query: 'x' }).linkedin_fetch_description).toBeUndefined();
    expect(
      buildSearchRequestBody({ query: 'x', linkedinFetchDescription: false }).linkedinFetchDescription,
    ).toBe(false);
    expect(
      buildSearchRequestBody({ query: 'x', linkedinFetchDescription: false }, 'snake')
        .linkedin_fetch_description,
    ).toBe(false);
  });

  it.each(['camel', 'snake', 'both'] as const)('sends locations in the %s style', (style) => {
    const body = buildSearchRequestBody({ query: 'x', locations: ['A', 'B'] }, style);
    expect(body.locations).toEqual(['A', 'B']);
  });

  it('sends camelCase exclusion keys by default', () => {
    const body = buildSearchRequestBody({
      query: 'x',
      excludeTitleTerms: ['senior'],
      excludeKeywords: ['polygraph'],
      excludePresets: ['security_clearance'],
    });
    expect(body).toMatchObject({
      excludeTitleTerms: ['senior'],
      excludeKeywords: ['polygraph'],
      excludePresets: ['security_clearance'],
    });
    expect(body).not.toHaveProperty('exclude_title_terms');
  });

  it('mirrors them in snake_case and sends both in "both"', () => {
    const params = { query: 'x', excludeTitleTerms: ['senior'], excludePresets: ['security_clearance'] };
    expect(buildSearchRequestBody(params, 'snake')).toMatchObject({
      exclude_title_terms: ['senior'],
      exclude_presets: ['security_clearance'],
    });
    expect(buildSearchRequestBody(params, 'snake')).not.toHaveProperty('excludeTitleTerms');
    expect(buildSearchRequestBody(params, 'both')).toMatchObject({
      excludeTitleTerms: ['senior'],
      exclude_title_terms: ['senior'],
    });
  });

  it('omits empty or blank lists', () => {
    const body = buildSearchRequestBody({ query: 'x', locations: [], excludeTitleTerms: ['  '], excludeKeywords: [] });
    expect(body).not.toHaveProperty('locations');
    expect(body).not.toHaveProperty('excludeTitleTerms');
    expect(body).not.toHaveProperty('excludeKeywords');
  });

  it('drops unknown presets so the search is not rejected', () => {
    const body = buildSearchRequestBody({ query: 'x', excludePresets: ['nope', 'SECURITY_CLEARANCE'] });
    expect(body.excludePresets).toEqual(['security_clearance']);
    expect(buildSearchRequestBody({ query: 'x', excludePresets: ['nope'] })).not.toHaveProperty('excludePresets');
  });

  it('accepts a bare string where a list is expected', () => {
    const body = buildSearchRequestBody({ query: 'x', locations: 'Berlin' as unknown as string[] });
    expect(body.locations).toEqual(['Berlin']);
  });

  it('cuts lists to what the API accepts', () => {
    const many = Array.from({ length: 30 }, (_, i) => `C${i}`);
    expect((buildSearchRequestBody({ query: 'x', locations: many }).locations as string[]).length).toBe(
      MCP_MAX_LOCATIONS,
    );
    expect(cleanList(['ok', 'x'.repeat(101), 7, ''], 50, 100)).toEqual(['ok']);
  });
});

describe('searchJobs — Spec 1700', () => {
  it('posts locations and exclusions, and reports the excluded count', async () => {
    const client = mockClient({ jobs: [], exclusion_metrics: { excluded_count: 4 } });

    const out = await searchJobs({ query: 'x', locations: ['A', 'B'], excludePresets: ['security_clearance'] });

    expect(client.post).toHaveBeenCalledWith(
      '/api/jobs/search',
      expect.objectContaining({ locations: ['A', 'B'], excludePresets: ['security_clearance'] }),
    );
    expect(out.excluded).toBe(4);
  });

  it('keeps the previous response shape without exclusions', async () => {
    mockClient({ jobs: [] });
    const out = await searchJobs({ query: 'x', locations: ['A', 'B'] });
    expect(out).not.toHaveProperty('excluded');
  });

  it('reports 0 when the server returns no metrics', async () => {
    mockClient({ jobs: [] });
    const out = await searchJobs({ query: 'x', excludeTitleTerms: ['senior'] });
    expect(out.excluded).toBe(0);
  });
});
