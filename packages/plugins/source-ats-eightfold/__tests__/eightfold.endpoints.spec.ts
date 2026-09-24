import { createHttpClient } from '@ever-jobs/common';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { EightfoldService } from '../src/eightfold.service';
import {
  EIGHTFOLD_JOBS_PATH,
  EIGHTFOLD_PCSX_SEARCH_PATH,
  EIGHTFOLD_PAGE_SIZE,
} from '../src/eightfold.constants';
import type { EightfoldPosition } from '../src/eightfold.types';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

const POSITION: EightfoldPosition = {
  id: 563980770511471,
  displayJobId: 'JR-2603147',
  name: 'MCU Architect',
  locations: ['Bangalore, Karnataka, India'],
  department: 'Business Units',
};

function pcsxBody(positions: EightfoldPosition[] = [POSITION], count = 1) {
  return {
    status: 200,
    error: { message: '', body: '' },
    data: { positions, count },
  };
}

describe('EightfoldService endpoint resolution', () => {
  let service: EightfoldService;
  let getMock: jest.Mock;

  beforeEach(() => {
    service = new EightfoldService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({
      get: getMock,
      setHeaders: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const input = () =>
    new ScraperInputDto({
      companySlug: 'globalfoundries',
      companyUrl: 'https://careers.gf.com',
      resultsWanted: 999,
    });

  it('uses the SmartApply endpoint when it returns a valid payload', async () => {
    getMock.mockResolvedValue({ data: { positions: [POSITION], count: 1 } });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].site).toBe(Site.EIGHTFOLD);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock.mock.calls[0][0]).toContain(EIGHTFOLD_JOBS_PATH);
  });

  it('falls back to PCSX search when SmartApply is gated', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes(EIGHTFOLD_JOBS_PATH)) {
        return Promise.resolve({ data: { message: 'Not authorized for PCSX' } });
      }
      if (url.includes(EIGHTFOLD_PCSX_SEARCH_PATH)) {
        return Promise.resolve({ data: pcsxBody() });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe('JR-2603147');
    expect(res.jobs[0].department).toBe('Business Units');
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[1][0]).toContain(EIGHTFOLD_PCSX_SEARCH_PATH);
  });

  it('falls back to PCSX search when SmartApply returns the HTML shell', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes(EIGHTFOLD_JOBS_PATH)) {
        return Promise.resolve({ data: '<!DOCTYPE html><html>...</html>' });
      }
      if (url.includes(EIGHTFOLD_PCSX_SEARCH_PATH)) {
        return Promise.resolve({ data: pcsxBody() });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(1);
    expect(getMock.mock.calls[1][0]).toContain(EIGHTFOLD_PCSX_SEARCH_PATH);
  });

  it('does not fall back on a legitimately empty board', async () => {
    getMock.mockResolvedValue({ data: { positions: [], count: 0 } });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock.mock.calls[0][0]).toContain(EIGHTFOLD_JOBS_PATH);
  });

  it('falls back to PCSX search when SmartApply answers with an HTTP error', async () => {
    // careers.gf.com behavior: apply/v2 → 403 (throws), pcsx/search → 200.
    const err = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403 },
    });
    getMock.mockImplementation((url: string) => {
      if (url.includes(EIGHTFOLD_JOBS_PATH)) return Promise.reject(err);
      if (url.includes(EIGHTFOLD_PCSX_SEARCH_PATH)) {
        return Promise.resolve({ data: pcsxBody() });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe('JR-2603147');
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[1][0]).toContain(EIGHTFOLD_PCSX_SEARCH_PATH);
  });

  it('surfaces diagnostics when every endpoint errors', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await service.scrape(input());

    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the resolved endpoint for subsequent pages', async () => {
    // count > PAGE_SIZE forces a second page; gated primary + open PCSX.
    const page2 = { ...POSITION, displayJobId: 'JR-9999999', id: 2 };
    getMock.mockImplementation((url: string) => {
      if (url.includes(EIGHTFOLD_JOBS_PATH)) {
        return Promise.resolve({ data: { message: 'Not authorized for PCSX' } });
      }
      if (url.includes(EIGHTFOLD_PCSX_SEARCH_PATH) && url.includes('start=0')) {
        return Promise.resolve({
          data: pcsxBody(new Array(EIGHTFOLD_PAGE_SIZE).fill(POSITION), EIGHTFOLD_PAGE_SIZE + 1),
        });
      }
      if (url.includes(EIGHTFOLD_PCSX_SEARCH_PATH) && url.includes(`start=${EIGHTFOLD_PAGE_SIZE}`)) {
        return Promise.resolve({ data: pcsxBody([page2], EIGHTFOLD_PAGE_SIZE + 1) });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const res = await service.scrape(input());

    expect(res.jobs.length).toBeGreaterThan(0);
    const calls = getMock.mock.calls.map((c) => c[0] as string);
    const gatedCalls = calls.filter((u) => u.includes(EIGHTFOLD_JOBS_PATH));
    const pcsxCalls = calls.filter((u) => u.includes(EIGHTFOLD_PCSX_SEARCH_PATH));
    expect(gatedCalls).toHaveLength(1);
    expect(pcsxCalls.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Spec 1689 (fork-sync hardening): the resolved endpoint is per scrape, not
 * per service. Nest providers are singletons, so ONE EightfoldService serves
 * every tenant — these tests deliberately reuse a single instance.
 */
describe('EightfoldService endpoint resolution is scoped per scrape', () => {
  const PCSX_ONLY_HOST = 'https://pcsxonly.eightfold.ai';
  const V2_ONLY_HOST = 'https://v2only.eightfold.ai';
  const PCSX_JOB: EightfoldPosition = { ...POSITION, id: 1, displayJobId: 'PCSX-1', name: 'PCSX Job' };
  const V2_JOB: EightfoldPosition = { ...POSITION, id: 2, displayJobId: 'V2-1', name: 'V2 Job' };

  let service: EightfoldService;
  let getMock: jest.Mock;

  /**
   * Tenant `pcsxonly` gates SmartApply with a 200 "Not authorized" body and
   * serves PCSX; tenant `v2only` is the reverse. Neither ever throws, so a
   * leaked endpoint shows up as a silent empty board (the reported failure).
   */
  const routeByTenant = (url: string) => {
    const gate = { data: { message: 'Not authorized for PCSX' } };
    if (url.startsWith(PCSX_ONLY_HOST)) {
      return Promise.resolve(url.includes(EIGHTFOLD_PCSX_SEARCH_PATH) ? { data: pcsxBody([PCSX_JOB], 1) } : gate);
    }
    if (url.startsWith(V2_ONLY_HOST)) {
      return Promise.resolve(url.includes(EIGHTFOLD_JOBS_PATH) ? { data: { positions: [V2_JOB], count: 1 } } : gate);
    }
    return Promise.reject(new Error('unexpected url ' + url));
  };

  const tenant = (slug: string) => new ScraperInputDto({ companySlug: slug, resultsWanted: 50 });

  beforeEach(() => {
    service = new EightfoldService();
    getMock = jest.fn(routeByTenant);
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock, setHeaders: jest.fn() });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('a PCSX-only tenant does not pin the endpoint for a later v2-only tenant', async () => {
    const a = await service.scrape(tenant('pcsxonly'));
    const b = await service.scrape(tenant('v2only'));

    expect(a.jobs.map((j) => j.atsId)).toEqual(['PCSX-1']);
    expect(b.jobs.map((j) => j.atsId)).toEqual(['V2-1']);
    // Tenant B started from the primary endpoint again, not tenant A's PCSX.
    const bCalls = getMock.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith(V2_ONLY_HOST));
    expect(bCalls).toHaveLength(1);
    expect(bCalls[0]).toContain(EIGHTFOLD_JOBS_PATH);
  });

  it('a v2-only tenant does not suppress the PCSX fallback for a later PCSX-only tenant', async () => {
    const b = await service.scrape(tenant('v2only'));
    const a = await service.scrape(tenant('pcsxonly'));

    expect(b.jobs.map((j) => j.atsId)).toEqual(['V2-1']);
    expect(a.jobs.map((j) => j.atsId)).toEqual(['PCSX-1']);
  });

  it('concurrent scrapes of different tenants on one instance do not race', async () => {
    const [a, b] = await Promise.all([service.scrape(tenant('pcsxonly')), service.scrape(tenant('v2only'))]);

    expect(a.jobs.map((j) => j.atsId)).toEqual(['PCSX-1']);
    expect(b.jobs.map((j) => j.atsId)).toEqual(['V2-1']);
  });

  it('keeps no endpoint state on the service instance', async () => {
    await service.scrape(tenant('pcsxonly'));

    expect(Object.prototype.hasOwnProperty.call(service, 'jobsPath')).toBe(false);
  });
});
