import { readFileSync } from 'fs';
import { join } from 'path';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';

const hiringHtml = readFileSync(join(__dirname, 'fixtures', 'hiring.html'), 'utf8');
const mainJs = readFileSync(join(__dirname, 'fixtures', 'main.js'), 'utf8');
const hiringChunk = readFileSync(join(__dirname, 'fixtures', 'hiring-chunk.js'), 'utf8');
const unrelatedChunk = readFileSync(
  join(__dirname, 'fixtures', 'unrelated-chunk.js'),
  'utf8',
);

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { LabsActorService } from '../src/labs-actor.service';
import { LABS_ACTOR_ALLOWED_HOSTS } from '../src/labs-actor.constants';

function respondWith(...pages: unknown[]): void {
  getMock.mockReset();
  for (const page of pages) getMock.mockResolvedValueOnce({ data: page });
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

describe('LabsActorService', () => {
  let service: LabsActorService;

  beforeEach(() => {
    getMock.mockReset();
    service = new LabsActorService();
  });

  it('maps every role from the embedded jobs array', async () => {
    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(4);
    expect(res.diagnostics).toBeUndefined();

    const hw = res.jobs.find((j) => j.atsId === 'hardware');
    expect(hw).toBeDefined();
    expect(hw!.id).toBe('labs_actor-hardware');
    expect(hw!.title).toBe('Hardware Engineer');
    expect(hw!.site).toBe(Site.LABS_ACTOR);
    expect(hw!.atsType).toBe('labs_actor');
    expect(hw!.companyName).toBe('Actor');
    expect(hw!.department).toBe('Hardware');
    expect(hw!.location?.city).toBe('Mountain View');
    expect(hw!.location?.state).toBe('CA');
    expect(hw!.employmentType).toBe('Full-time · On-site');
    expect(hw!.jobType).toEqual([JobType.FULL_TIME]);
  });

  it('scans chunk-map chunks until one carries the jobs array', async () => {
    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(4);
    expect(getMock).toHaveBeenNthCalledWith(1, 'https://labs.actor/hiring');
    expect(getMock).toHaveBeenNthCalledWith(
      2,
      'https://labs.actor/static/js/main.0d3242ba.js',
    );
    expect(getMock).toHaveBeenNthCalledWith(
      3,
      'https://labs.actor/static/js/323.b9794b38.chunk.js',
    );
    expect(getMock).toHaveBeenNthCalledWith(
      4,
      'https://labs.actor/static/js/848.435a36aa.chunk.js',
    );
    expect(getMock).toHaveBeenCalledTimes(4);
  });

  it('composes description from summary, responsibilities, and requirements', async () => {
    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const res = await service.scrape(new ScraperInputDto({}));
    const ml = res.jobs.find((j) => j.atsId === 'ml')!;
    expect(ml.description).toContain('What you will do:');
    expect(ml.description).toContain('What we are looking for:');
    expect(ml.description).toContain('- ');
  });

  it('routes applyUrl to the team mailbox as a mailto', async () => {
    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const res = await service.scrape(new ScraperInputDto({}));

    const hw = res.jobs.find((j) => j.atsId === 'hardware')!;
    expect(hw.applyUrl).toBe(
      `mailto:lane@labs.actor?subject=${encodeURIComponent('Hardware Engineer — application')}`,
    );
    const gtm = res.jobs.find((j) => j.atsId === 'gtm')!;
    expect(gtm.applyUrl).toContain('mailto:lane@labs.actor');

    const ml = res.jobs.find((j) => j.atsId === 'ml')!;
    expect(ml.applyUrl).toContain('mailto:shashi@labs.actor');
    const deployed = res.jobs.find((j) => j.atsId === 'deployed')!;
    expect(deployed.applyUrl).toContain('mailto:shashi@labs.actor');
  });

  it('points jobUrl at the careers page (roles expand inline)', async () => {
    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const res = await service.scrape(new ScraperInputDto({}));
    for (const job of res.jobs) {
      expect(job.jobUrl).toBe('https://labs.actor/hiring');
      expect(job.jobUrlDirect).toBe('https://labs.actor/hiring');
    }
  });

  it('returns an empty diagnostic when no chunk carries the jobs array', async () => {
    respondWith(hiringHtml, mainJs, unrelatedChunk, unrelatedChunk, unrelatedChunk);
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns an empty diagnostic when the shell has no main bundle', async () => {
    respondWith('<html><body>no scripts</body></html>');
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns a classified diagnostic when a fetch throws', async () => {
    getMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBeDefined();
  });

  it('honours searchTerm, location, and resultsWanted filters', async () => {
    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'Machine Learning' }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe('ml');

    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const loc = await service.scrape(
      new ScraperInputDto({ location: 'mountain view' }),
    );
    expect(loc.jobs).toHaveLength(4);

    respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
    const limited = await service.scrape(
      new ScraperInputDto({ resultsWanted: 2, offset: 1 }),
    );
    expect(limited.jobs).toHaveLength(2);
    expect(limited.jobs[0].atsId).toBe('hardware');
  });

  describe('companyUrl pin-or-ignore (Spec 1689)', () => {
    it('fetches an on-domain companyUrl and keeps it as jobUrl', async () => {
      respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
      const res = await service.scrape(
        new ScraperInputDto({ companyUrl: 'https://www.labs.actor/hiring?ref=1' }),
      );
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.labs.actor/hiring?ref=1');
      expect(res.jobs[0].jobUrl).toBe('https://www.labs.actor/hiring?ref=1');
    });

    it.each([
      ['off-domain', 'https://evil.example/hiring'],
      ['lookalike', 'https://labs.actor.evil.example/hiring'],
      ['userinfo smuggling', 'https://labs.actor:pw@evil.example/'],
      ['internal IP', 'http://127.0.0.1:3001/api/jobs'],
      ['hex loopback', 'http://0x7f.0.0.1/'],
    ])('ignores a %s companyUrl and fetches the default board', async (_label, companyUrl) => {
      respondWith(hiringHtml, mainJs, unrelatedChunk, hiringChunk);
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://labs.actor/hiring');
      for (const call of getMock.mock.calls) {
        expect(new URL(call[0] as string).hostname).toBe('labs.actor');
      }
      expect(res.jobs).toHaveLength(4);
    });
  });

  describe('ReDoS hardening (Spec 1689)', () => {
    type Internals = {
      scalarField(objText: string, key: string): string | null;
      chunkUrls(mainJs: string): string[];
      locationBeforeDot(location: string): string;
    };
    const internals = () => service as unknown as Internals;

    it('scalarField stays linear on 64 backslashes before a line break', () => {
      const text = `{title:"${'\\'.repeat(64)}\n"}`;
      expect(bestOf3Ms(() => internals().scalarField(text, 'title'))).toBeLessThan(50);
      expect(internals().scalarField(text, 'title')).toBeNull();
    });

    it('scalarField still unescapes both quote styles', () => {
      expect(internals().scalarField(`{title:"a \\"b\\" \\u00e9",x:1}`, 'title')).toBe('a "b" é');
      expect(internals().scalarField(`{title:'it\\'s'}`, 'title')).toBe("it's");
    });

    it('the chunk-map regex stays linear on 40 comma-less pairs that never close', () => {
      const pairs = Array.from({ length: 40 }, (_, i) => `${i}:"abc${i}"    `).join('');
      const mainJs = `n.u=e=>"static/js/"+e+"."+{${pairs}}[e]+".nope.js"`;
      expect(bestOf3Ms(() => internals().chunkUrls(mainJs))).toBeLessThan(50);
      expect(internals().chunkUrls(mainJs)).toEqual([]);
    });

    it('the chunk-map regex still reads comma and whitespace separated maps', () => {
      const mainJs = `n.u=e=>"static/js/"+e+"."+{115:"bae9c619", 848:"435a36aa" ,9:"ff"  10:"0a"}[e]+".chunk.js"`;
      expect(internals().chunkUrls(mainJs)).toEqual([
        'https://labs.actor/static/js/115.bae9c619.chunk.js',
        'https://labs.actor/static/js/848.435a36aa.chunk.js',
        'https://labs.actor/static/js/9.ff.chunk.js',
        'https://labs.actor/static/js/10.0a.chunk.js',
      ]);
    });

    it('locationBeforeDot matches the old replace(/\\s*·.*$/, "") and is linear', () => {
      const old = (s: string) => s.replace(/\s*·.*$/, '');
      for (const s of [
        'Mountain View, CA · On-site',
        'Mountain View, CA',
        'A  ·  B · C',
        'A\n· B',
        'A · B\nC · D',
        'A · B\nC',
        '·',
        '',
      ]) {
        expect(internals().locationBeforeDot(s)).toBe(old(s));
      }
      const long = `A${' '.repeat(100_000)}B`;
      expect(internals().locationBeforeDot(long)).toBe(long);
      expect(bestOf3Ms(() => internals().locationBeforeDot(long))).toBeLessThan(50);
    });

    it('scrapes past a pathological entry end-to-end', async () => {
      const chunk = `var J=[{id:"a",title:"${'\\'.repeat(64)}\n"},{id:"b",title:"Real Role",team:"ML",location:"Mountain View, CA · On-site"}];`;
      const main = `n.u=e=>"static/js/"+e+"."+{7:"abcdef01"}[e]+".chunk.js"`;
      respondWith(hiringHtml, main, chunk);
      const res = await service.scrape(new ScraperInputDto({}));
      expect(res.jobs.map((j) => j.title)).toEqual(['Real Role']);
      expect(res.jobs[0].location?.city).toBe('Mountain View');
    });

    it('treats a jobs literal over the size cap as malformed', async () => {
      const chunk = `var J=[{id:"a",title:"${'x'.repeat(1_000_001)}"}];`;
      const main = `n.u=e=>"static/js/"+e+"."+{7:"abcdef01"}[e]+".chunk.js"`;
      respondWith(hiringHtml, main, chunk);
      const res = await service.scrape(new ScraperInputDto({}));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('empty');
    });
  });
});

describe('LabsActorService companyUrl hygiene (Spec 1689)', () => {
  afterEach(() => getMock.mockReset());

  it('logs only the host of a refused companyUrl, never its credentials or query', () => {
    const svc = new LabsActorService();
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
    await new LabsActorService().scrape(new ScraperInputDto({})).catch(() => undefined);
    expect(createHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRedirectHosts: LABS_ACTOR_ALLOWED_HOSTS }),
    );
  });
});
