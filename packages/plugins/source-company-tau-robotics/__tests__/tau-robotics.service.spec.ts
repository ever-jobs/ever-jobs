import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(join(__dirname, 'fixtures', 'careers.html'), 'utf8');
const applyJs = readFileSync(join(__dirname, 'fixtures', 'apply.js'), 'utf8');

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { TauRoboticsService } from '../src/tau-robotics.service';
import { TAU_ROBOTICS_ALLOWED_HOSTS } from '../src/tau-robotics.constants';

function respondWith(careers: string, apply: string | Error): void {
  getMock.mockImplementation((url: string) => {
    if (url.endsWith('apply.js')) {
      if (apply instanceof Error) return Promise.reject(apply);
      return Promise.resolve({ data: apply });
    }
    return Promise.resolve({ data: careers });
  });
}

/**
 * Best of three wall-clock runs, in ms. One run can overshoot a small budget
 * on a throttled CI pod (CFS quota, GC pause); a super-linear regex overshoots
 * it on every run, by orders of magnitude.
 */
function bestOf3Ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('TauRoboticsService', () => {
  let service: TauRoboticsService;

  beforeEach(() => {
    getMock.mockReset();
    service = new TauRoboticsService();
  });

  it('maps all 8 roles from the careers anchors', async () => {
    respondWith(careersHtml, applyJs);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(8);
    expect(res.diagnostics).toBeUndefined();

    const world = res.jobs.find((j) => j.id === 'tau-robotics-world-models');
    expect(world).toBeDefined();
    expect(world!.title).toBe('Research Engineer/Scientist, World Models');
    expect(world!.site).toBe(Site.TAU_ROBOTICS);
    expect(world!.atsType).toBe('tau-robotics');
    expect(world!.companyName).toBe('Tau Robotics');
    expect(world!.jobUrl).toBe('https://www.tau-robotics.com/apply.html?role=world-models');
    expect(world!.department).toBe('Research');
    expect(world!.location?.city).toBe('San Francisco');
    expect(world!.jobType).toEqual(['fulltime']);
  });

  it('skips the open-application link', async () => {
    respondWith(careersHtml, applyJs);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs.some((j) => j.atsId === 'open-application')).toBe(false);
  });

  it('populates description from the apply.js ROLES map', async () => {
    respondWith(careersHtml, applyJs);
    const res = await service.scrape(new ScraperInputDto({}));
    const world = res.jobs.find((j) => j.id === 'tau-robotics-world-models');
    expect(world!.description).toContain('Responsibilities:');
    expect(world!.description).toContain('world models');
    expect(world!.description).toContain('Requirements:');
    expect(world!.description).toContain('PyTorch');
  });

  it('emits rows without descriptions when apply.js is unavailable', async () => {
    respondWith(careersHtml, new Error('404'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(8);
    expect(res.jobs.every((j) => !j.description)).toBe(true);
  });

  it('emits a row without description for a slug missing from ROLES', async () => {
    const partialApplyJs = `const ROLES = {\n  'world-models': {\n    title: 'Research Engineer/Scientist, World Models',\n    meta: 'Research · San Francisco · Full-time',\n    responsibilities: ['Do things'],\n    requirements: ['Know things'],\n  },\n};\n`;
    respondWith(careersHtml, partialApplyJs);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(8);
    const world = res.jobs.find((j) => j.id === 'tau-robotics-world-models');
    const other = res.jobs.find((j) => j.id === 'tau-robotics-robotics-technician');
    expect(world!.description).toContain('Do things');
    expect(other!.description).toBeUndefined();
  });

  it('returns an empty diagnostic when the careers page has no role anchors', async () => {
    respondWith('<html><body><p>no roles</p></body></html>', applyJs);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns diagnostics when the careers fetch fails', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('honors resultsWanted', async () => {
    respondWith(careersHtml, applyJs);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 3 }));
    expect(res.jobs).toHaveLength(3);
  });

  describe('companyUrl pin-or-ignore (Spec 1689)', () => {
    it('fetches an on-domain companyUrl', async () => {
      respondWith(careersHtml, applyJs);
      await service.scrape(
        new ScraperInputDto({ companyUrl: 'https://tau-robotics.com/careers#open' }),
      );
      expect(getMock).toHaveBeenCalledWith('https://tau-robotics.com/careers#open');
    });

    it.each([
      ['off-domain', 'https://evil.example/careers'],
      ['lookalike', 'https://tau-robotics.com.evil.example/careers'],
      ['internal IP', 'http://10.1.2.3:9000/'],
      ['metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['cluster service', 'http://argocd-server.argocd.svc/'],
    ])('ignores a %s companyUrl and fetches the default board', async (_label, companyUrl) => {
      respondWith(careersHtml, applyJs);
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      const urls = getMock.mock.calls.map((call) => call[0] as string);
      expect(urls).toEqual([
        'https://www.tau-robotics.com/careers',
        'https://www.tau-robotics.com/apply.js',
      ]);
      expect(res.jobs).toHaveLength(8);
    });
  });

  describe('apply.js parsing (Spec 1689)', () => {
    type Parser = {
      literalArray(literal: string, key: string): string[] | undefined;
      parseRolesLiteral(js: string): Map<string, { requirements?: string[] }>;
    };
    const parser = () => service as unknown as Parser;

    it('literalArray stays linear on 40 items with no reachable closing bracket', () => {
      const items = Array.from({ length: 40 }, (_, i) => `'item ${i}'`).join(', ');
      const literal = `{ requirements: [${items}, "see [1" }`;
      expect(bestOf3Ms(() => parser().literalArray(literal, 'requirements'))).toBeLessThan(50);
      expect(parser().literalArray(literal, 'requirements')).toBeUndefined();
    });

    it('literalArray stays linear on 40 items with no closing bracket at all', () => {
      const items = Array.from({ length: 40 }, (_, i) => `'item ${i}'`).join(', ');
      const literal = `{ requirements: [${items} }`;
      expect(bestOf3Ms(() => parser().literalArray(literal, 'requirements'))).toBeLessThan(50);
      expect(parser().literalArray(literal, 'requirements')).toBeUndefined();
    });

    it('literalArray keeps bracketed and double-quoted items', () => {
      const literal = `{ requirements: ['a [x] b', "don't [panic]", 'it\\'s'], other: ['z'] }`;
      expect(parser().literalArray(literal, 'requirements')).toEqual([
        'a [x] b',
        "don't [panic]",
        "it's",
      ]);
    });

    it('parses a ROLES entry whose array holds a double-quoted bracket', () => {
      const items = Array.from({ length: 40 }, (_, i) => `'req ${i}'`).join(', ');
      const js = `const ROLES = {\n  'world-models': {\n    title: 'T',\n    requirements: [${items}, "see [1]"],\n  },\n};`;
      expect(bestOf3Ms(() => parser().parseRolesLiteral(js))).toBeLessThan(50);
      const roles = parser().parseRolesLiteral(js);
      expect(roles.get('world-models')?.requirements).toHaveLength(41);
      expect(roles.get('world-models')?.requirements?.[40]).toBe('see [1]');
    });

    it('treats an apply.js literal over the size cap as absent', () => {
      const js = `const ROLES = { 'world-models': { title: '${'x'.repeat(1_000_001)}' } };`;
      expect(parser().parseRolesLiteral(js).size).toBe(0);
    });
  });
});

describe('TauRoboticsService companyUrl hygiene (Spec 1689)', () => {
  afterEach(() => getMock.mockReset());

  it('logs only the host of a refused companyUrl, never its credentials or query', () => {
    const svc = new TauRoboticsService();
    const debug = jest
      .spyOn((svc as unknown as { logger: { debug: (m: string) => void } }).logger, 'debug')
      .mockImplementation(() => undefined);
    (svc as unknown as { careersUrl(input: ScraperInputDto): string }).careersUrl(
      new ScraperInputDto({ companyUrl: 'https://user:s3cret@evil.example/x?token=t0k' }),
    );
    const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('evil.example');
    expect(logged).not.toMatch(/s3cret|t0k|user:/);
  });

  it('pins every redirect hop to the plugin allowlist', async () => {
    const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
      createHttpClient: jest.Mock;
    };
    createHttpClient.mockClear();
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await new TauRoboticsService().scrape(new ScraperInputDto({})).catch(() => undefined);
    expect(createHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRedirectHosts: TAU_ROBOTICS_ALLOWED_HOSTS }),
    );
  });
});
