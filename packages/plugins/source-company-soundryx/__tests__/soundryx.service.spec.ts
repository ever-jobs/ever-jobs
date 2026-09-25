import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(join(__dirname, 'fixtures', 'careers.html'), 'utf8');
const jobPages: Record<string, string> = {
  'https://soundryx.com/careers/00001-founding-electrical-engineer/': readFileSync(
    join(__dirname, 'fixtures', 'job-electrical.html'),
    'utf8',
  ),
  'https://soundryx.com/careers/00002-founding-audio-ml-engineer/': readFileSync(
    join(__dirname, 'fixtures', 'job-ml.html'),
    'utf8',
  ),
  'https://soundryx.com/careers/00003-founding-fde-spanish/': readFileSync(
    join(__dirname, 'fixtures', 'job-fde.html'),
    'utf8',
  ),
};

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { SoundryxService } from '../src/soundryx.service';
import { SOUNDRYX_ALLOWED_HOSTS } from '../src/soundryx.constants';

function respondWithPages(pages: Record<string, string>): void {
  getMock.mockReset();
  getMock.mockImplementation((url: string) => {
    const data = pages[url];
    if (data === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve({ data });
  });
}

function live(): void {
  respondWithPages({ 'https://soundryx.com/careers/': careersHtml, ...jobPages });
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

describe('SoundryxService', () => {
  let service: SoundryxService;

  beforeEach(() => {
    getMock.mockReset();
    service = new SoundryxService();
  });

  it('maps every role tile to its detail page', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(3);
    expect(res.diagnostics).toBeUndefined();

    const ee = res.jobs.find((j) => j.atsId === '00001-founding-electrical-engineer');
    expect(ee).toBeDefined();
    expect(ee!.id).toBe('soundryx-00001-founding-electrical-engineer');
    expect(ee!.title).toBe('Founding Electrical Engineer');
    expect(ee!.site).toBe(Site.SOUNDRYX);
    expect(ee!.atsType).toBe('soundryx');
    expect(ee!.companyName).toBe('Soundryx');
    expect(ee!.location?.city).toBe('Los Angeles');
    expect(ee!.location?.state).toBe('CA');
    expect(ee!.workFromHomeType).toBe('On Site');
    expect(ee!.jobUrl).toBe('https://soundryx.com/careers/00001-founding-electrical-engineer/');
    expect(ee!.jobUrlDirect).toBe(ee!.jobUrl);
  });

  it('fetches the index then each tile detail page', async () => {
    live();
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenNthCalledWith(1, 'https://soundryx.com/careers/');
    const urls = getMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://soundryx.com/careers/00001-founding-electrical-engineer/');
    expect(urls).toContain('https://soundryx.com/careers/00002-founding-audio-ml-engineer/');
    expect(urls).toContain('https://soundryx.com/careers/00003-founding-fde-spanish/');
    expect(getMock).toHaveBeenCalledTimes(4);
  });

  it('composes description from the detail body without footnotes', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const ee = res.jobs.find((j) => j.atsId === '00001-founding-electrical-engineer')!;
    expect(ee.description).toContain('What You');
    expect(ee.description).toContain('PCB');
    expect(ee.description).toContain('Export Control');
    expect(ee.description).not.toContain('22 C.F.R.');
    expect(ee.description!.length).toBeGreaterThan(1000);
  });

  it('decodes the Cloudflare-protected apply mailto', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    for (const job of res.jobs) {
      expect(job.applyUrl).toBe('mailto:careers@soundryx.com');
    }
  });

  it('parses the Compensation section into compensation', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const ee = res.jobs.find((j) => j.atsId === '00001-founding-electrical-engineer')!;
    expect(ee.compensation).toBeDefined();
    expect(ee.compensation?.minAmount).toBe(130000);
    expect(ee.compensation?.maxAmount).toBe(180000);
    expect(ee.compensation?.currency).toBe('USD');
  });

  it('returns an empty diagnostic when the index has no tiles', async () => {
    respondWithPages({ 'https://soundryx.com/careers/': '<html><body>empty</body></html>' });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns a classified diagnostic when the index fetch throws', async () => {
    getMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBeDefined();
  });

  it('honours searchTerm, location, and resultsWanted filters', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({ searchTerm: 'Audio ML' }));
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe('00002-founding-audio-ml-engineer');

    live();
    const loc = await service.scrape(new ScraperInputDto({ location: 'los angeles' }));
    expect(loc.jobs).toHaveLength(3);

    live();
    const limited = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, offset: 1 }),
    );
    expect(limited.jobs).toHaveLength(1);
    expect(limited.jobs[0].atsId).toBe('00002-founding-audio-ml-engineer');
  });

  describe('URL pinning (Spec 1689)', () => {
    it('fetches an on-domain companyUrl and resolves tiles against it', async () => {
      respondWithPages({
        'https://www.soundryx.com/careers/': careersHtml,
        'https://www.soundryx.com/careers/00001-founding-electrical-engineer/':
          jobPages['https://soundryx.com/careers/00001-founding-electrical-engineer/'],
      });
      const res = await service.scrape(
        new ScraperInputDto({ companyUrl: 'http://www.soundryx.com/careers/' }),
      );
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.soundryx.com/careers/');
      expect(res.jobs.map((j) => j.jobUrl)).toEqual([
        'https://www.soundryx.com/careers/00001-founding-electrical-engineer/',
      ]);
    });

    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://soundryx.com.evil.example/careers/'],
      ['internal IP', 'http://10.96.0.1/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://svc.cluster.local/careers/'],
    ])('ignores a %s companyUrl and fetches the default index', async (_label, companyUrl) => {
      live();
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://soundryx.com/careers/');
      expect(res.jobs).toHaveLength(3);
    });

    it('never follows a tile that links off soundryx.com', async () => {
      const index =
        '<a class="srx-tile is-link" href="http://169.254.169.254/careers/00009-meta/"><h3>Meta</h3></a>' +
        '<a class="srx-tile is-link" href="https://evil.example/careers/00008-evil/"><h3>Evil</h3></a>' +
        '<a class="srx-tile is-link" href="//evil.example/careers/00007-proto/"><h3>Proto</h3></a>' +
        '<a class="srx-tile is-link" href="/careers/00001-founding-electrical-engineer/"><h3>EE</h3></a>';
      respondWithPages({
        'https://soundryx.com/careers/': index,
        'https://soundryx.com/careers/00001-founding-electrical-engineer/':
          jobPages['https://soundryx.com/careers/00001-founding-electrical-engineer/'],
      });
      const res = await service.scrape(new ScraperInputDto({}));
      const urls = getMock.mock.calls.map((c) => c[0] as string);
      expect(urls).toEqual([
        'https://soundryx.com/careers/',
        'https://soundryx.com/careers/00001-founding-electrical-engineer/',
      ]);
      expect(res.jobs).toHaveLength(1);
    });
  });

  describe('location parsing (Spec 1689)', () => {
    type Internals = { stripParentheticals(value: string): string };
    const strip = (s: string) =>
      (service as unknown as Internals).stripParentheticals(s).replace(/\s+/g, ' ').trim();
    const old = (s: string) => s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

    it('matches the old parenthetical strip on ordinary and odd input', () => {
      for (const s of [
        'Los Angeles, CA (onsite)',
        'Los Angeles, CA',
        'A (x) B (y) C',
        'A (b (c) d) e',
        'A (unclosed',
        'A ) B (c)',
        '(x)',
        '',
      ]) {
        expect(strip(s)).toBe(old(s));
      }
    });

    it('stays linear on many unclosed parentheses and long whitespace runs', () => {
      const nasty = `${'('.repeat(50_000)}${' '.repeat(50_000)}x`;
      expect(bestOf3Ms(() => strip(nasty))).toBeLessThan(50);
    });
  });
});

describe('SoundryxService companyUrl hygiene (Spec 1689)', () => {
  afterEach(() => getMock.mockReset());

  it('logs only the host of a refused companyUrl, never its credentials or query', () => {
    const svc = new SoundryxService();
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
    await new SoundryxService().scrape(new ScraperInputDto({})).catch(() => undefined);
    expect(createHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRedirectHosts: SOUNDRYX_ALLOWED_HOSTS }),
    );
  });
});
