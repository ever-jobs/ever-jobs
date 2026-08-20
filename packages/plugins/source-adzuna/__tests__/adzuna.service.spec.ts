import 'reflect-metadata';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: () => ({ get: mockGet, setHeaders: mockSetHeaders }),
  randomSleep: jest.fn().mockResolvedValue(undefined),
}));

import { ScraperInputDto } from '@ever-jobs/models';
import { AdzunaService } from '../src/adzuna.service';

/**
 * Regression test for Spec 1686.
 *
 * Adzuna's pagination catch ends in `break`, and the diagnostics assignment was
 * originally appended to the END of that catch — i.e. after the `break`, where
 * it could never run. `tsc` does not flag unreachable code after a `break`, so
 * every static gate passed and the service still returned a bare empty result
 * for an HTTP 500.
 *
 * This pins the failure path itself rather than the shape of the code, so the
 * same mistake cannot be reintroduced silently.
 */
describe('AdzunaService failure diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Credentials via input.auth so the test does not depend on env at import time. */
  const input = () =>
    new ScraperInputDto({
      searchTerm: 'node',
      auth: { adzuna: { appId: 'test-id', appKey: 'test-key' } },
    } as never);

  it('reports fetch_error rather than a bare empty result on an HTTP 500', async () => {
    mockGet.mockRejectedValue(new Error('Request failed with status code 500'));

    const result = await new AdzunaService().scrape(input());

    expect(result.jobs).toEqual([]);
    // The assertion that actually matters: an upstream failure must be
    // distinguishable from a legitimately empty feed.
    expect(result.diagnostics?.reason).toBe('fetch_error');
    expect(result.diagnostics?.detail).toContain('500');
  });

  it('reports bad_input when credentials are missing', async () => {
    const result = await new AdzunaService().scrape(
      new ScraperInputDto({ searchTerm: 'node' }),
    );

    expect(result.diagnostics?.reason).toBe('bad_input');
  });

  it('reports blocked for a 403', async () => {
    mockGet.mockRejectedValue(new Error('Request failed with status code 403'));

    const result = await new AdzunaService().scrape(input());

    expect(result.diagnostics?.reason).toBe('blocked');
  });
});
