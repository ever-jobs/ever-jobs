import { gzipSync } from 'zlib';

import {
  decodeSitemapBody,
  fetchSitemap,
  parseLastmod,
  parseSitemapText,
  parseSitemapXml,
  SitemapHttp,
  SITEMAP_DEFAULT_MAX_BYTES,
  SITEMAP_MAX_ELEMENT_DEPTH,
  sortSitemapEntriesByLastmod,
} from '../src/http/crawl/sitemap';
import * as crawlIndex from '../src/http/crawl';

const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function urlset(...urls: Array<[string, string?]>): string {
  const body = urls
    .map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${NS}">\n${body}\n</urlset>`;
}

function sitemapIndex(...locs: string[]): string {
  const body = locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join('');
  return `<?xml version="1.0"?><sitemapindex xmlns="${NS}">${body}</sitemapindex>`;
}

/** A fake HTTP client serving a fixed map of URL → body (string, Buffer, or Error). */
function fakeHttp(routes: Record<string, string | Buffer | Error>) {
  const calls: Array<{ url: string; config: any }> = [];
  const http: SitemapHttp = {
    get: jest.fn(async (url: string, config?: any) => {
      calls.push({ url, config });
      const body = routes[url];
      if (body === undefined) {
        throw Object.assign(new Error('Request failed with status code 404'), {
          response: { status: 404 },
        });
      }
      if (body instanceof Error) throw body;
      return { data: body as any, status: 200, headers: {} };
    }),
  };
  return { http, calls };
}

describe('crawl sitemap toolkit (Spec 1691)', () => {
  it('is exported from the crawl index', () => {
    expect(crawlIndex.fetchSitemap).toBe(fetchSitemap);
    expect(crawlIndex.parseSitemapXml).toBe(parseSitemapXml);
    expect(crawlIndex.parseLastmod).toBe(parseLastmod);
  });

  describe('parseLastmod', () => {
    it.each([
      ['2026-09-24T10:11:12Z', '2026-09-24T10:11:12.000Z'],
      ['2026-09-24T10:11:12+02:00', '2026-09-24T08:11:12.000Z'],
      ['2026-09-24T10:11:12-0530', '2026-09-24T15:41:12.000Z'],
      ['2026-09-24T10:11:12+02', '2026-09-24T08:11:12.000Z'],
      ['2026-09-24T10:11Z', '2026-09-24T10:11:00.000Z'],
      ['2026-09-24T10:11:12.345Z', '2026-09-24T10:11:12.345Z'],
      ['2026-09-24T10:11:12.3456789+00:00', '2026-09-24T10:11:12.345Z'],
      // no time zone → UTC (never the server's local zone)
      ['2026-09-24T10:11:12', '2026-09-24T10:11:12.000Z'],
      ['2026-09-24 10:11:12', '2026-09-24T10:11:12.000Z'],
      ['2026-09-24 10:11:12 UTC', '2026-09-24T10:11:12.000Z'],
      ['  2026-09-24 10:11:12  ', '2026-09-24T10:11:12.000Z'],
      ['2026-09-24', '2026-09-24T00:00:00.000Z'],
      ['2026-09', '2026-09-01T00:00:00.000Z'],
      ['2026', '2026-01-01T00:00:00.000Z'],
      ['2024-02-29', '2024-02-29T00:00:00.000Z'],
      ['2026-09-24T24:00:00Z', '2026-09-25T00:00:00.000Z'],
      ['Thu, 24 Sep 2026 10:11:12 GMT', '2026-09-24T10:11:12.000Z'],
    ])('parses %j', (raw, iso) => {
      expect(parseLastmod(raw)?.toISOString()).toBe(iso);
    });

    it.each([
      undefined,
      '',
      '   ',
      'yesterday',
      '2026-13-01',
      '2026-00-10',
      '2026-02-30',
      '2025-02-29',
      '2026-09-24T25:00:00Z',
      '2026-09-24T10:60:00Z',
      '2026-09-24T24:30:00Z',
      '2026-09-24T10:00:00+25:00',
      '24/09/2026',
      '2026-09-24T10:00:00 Europe/Paris',
    ])('rejects %j', (raw) => {
      expect(parseLastmod(raw as string | undefined)).toBeUndefined();
    });

    it('rejects non-strings without throwing', () => {
      expect(parseLastmod(123 as unknown as string)).toBeUndefined();
      expect(parseLastmod(null as unknown as string)).toBeUndefined();
    });
  });

  describe('parseSitemapXml', () => {
    it('parses a urlset with and without lastmod', () => {
      const { urls, sitemaps } = parseSitemapXml(
        urlset(['https://a.example/1', '2026-09-24 10:00:00'], ['https://a.example/2']),
      );
      expect(sitemaps).toEqual([]);
      expect(urls).toEqual([
        {
          loc: 'https://a.example/1',
          lastmodRaw: '2026-09-24 10:00:00',
          lastmod: new Date('2026-09-24T10:00:00Z'),
        },
        { loc: 'https://a.example/2' },
      ]);
    });

    it('parses a sitemapindex', () => {
      const xml = `<sitemapindex xmlns="${NS}">
        <sitemap><loc>https://a.example/s1.xml</loc><lastmod>2026-09-01</lastmod></sitemap>
        <sitemap><loc>https://a.example/s2.xml.gz</loc></sitemap>
      </sitemapindex>`;
      const { urls, sitemaps } = parseSitemapXml(xml);
      expect(urls).toEqual([]);
      expect(sitemaps.map((s) => s.loc)).toEqual(['https://a.example/s1.xml', 'https://a.example/s2.xml.gz']);
      expect(sitemaps[0].lastmod?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('decodes entities and numeric references, trims whitespace', () => {
      const { urls } = parseSitemapXml(
        urlset(['\n   https://a.example/?a=1&amp;b=2&#38;c=&#x33;&lt;&gt;&quot;&apos;   \n']),
      );
      expect(urls[0].loc).toBe('https://a.example/?a=1&b=2&c=3<>"\'');
    });

    it('keeps unknown entities verbatim', () => {
      const { urls } = parseSitemapXml(urlset(['https://a.example/?x=&nbsp;&bogus']));
      expect(urls[0].loc).toBe('https://a.example/?x=&nbsp;&bogus');
    });

    it('reads CDATA sections (with no entity decoding inside)', () => {
      const xml = `<urlset xmlns="${NS}"><url><loc><![CDATA[https://a.example/?a=1&b=2]]></loc>
        <lastmod> <![CDATA[2026-09-24]]> </lastmod></url></urlset>`;
      const { urls } = parseSitemapXml(xml);
      expect(urls).toEqual([
        { loc: 'https://a.example/?a=1&b=2', lastmodRaw: '2026-09-24', lastmod: new Date('2026-09-24T00:00:00Z') },
      ]);
    });

    it('handles prefixed namespaces', () => {
      const xml = `<?xml version="1.0"?>
        <sm:urlset xmlns:sm="${NS}">
          <sm:url><sm:loc>https://a.example/p</sm:loc><sm:lastmod>2026-09-24</sm:lastmod></sm:url>
        </sm:urlset>`;
      const { urls } = parseSitemapXml(xml);
      expect(urls.map((u) => u.loc)).toEqual(['https://a.example/p']);
      expect(urls[0].lastmodRaw).toBe('2026-09-24');
    });

    it('ignores image/video/xhtml extension elements (never mistakes image:loc for the page)', () => {
      const xml = `<urlset xmlns="${NS}" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
          xmlns:xhtml="http://www.w3.org/1999/xhtml">
        <url>
          <image:image><image:loc>https://cdn.example/img.png</image:loc></image:image>
          <loc>https://a.example/page</loc>
          <xhtml:link rel="alternate" hreflang="fr" href="https://a.example/fr/page"/>
          <image:loc>https://cdn.example/stray.png</image:loc>
        </url>
      </urlset>`;
      const { urls } = parseSitemapXml(xml);
      expect(urls).toEqual([{ loc: 'https://a.example/page' }]);
    });

    it('skips comments, processing instructions and a DOCTYPE with an internal subset', () => {
      const xml = `<?xml version="1.0"?>
        <!DOCTYPE urlset [ <!ENTITY foo "bar"> ]>
        <!-- <url><loc>https://a.example/commented</loc></url> -->
        <?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
        <urlset xmlns="${NS}"><url><loc>https://a.example/real</loc></url></urlset>`;
      expect(parseSitemapXml(xml).urls.map((u) => u.loc)).toEqual(['https://a.example/real']);
    });

    it('handles attributes containing ">" and self-closing elements', () => {
      const xml = `<urlset xmlns="${NS}" data-x="a>b"><url><loc>https://a.example/1</loc><lastmod/></url>
        <url/><url><loc>https://a.example/2</loc></url></urlset>`;
      expect(parseSitemapXml(xml).urls).toEqual([{ loc: 'https://a.example/1' }, { loc: 'https://a.example/2' }]);
    });

    it('keeps the first <loc> when an entry repeats it and drops entries without one', () => {
      const xml = `<urlset xmlns="${NS}"><url><loc>https://a.example/1</loc><loc>https://a.example/dup</loc></url>
        <url><lastmod>2026-09-24</lastmod></url><url><loc>   </loc></url></urlset>`;
      expect(parseSitemapXml(xml).urls).toEqual([{ loc: 'https://a.example/1' }]);
    });

    it('keeps a raw lastmod it cannot parse (lastmod undefined)', () => {
      const { urls } = parseSitemapXml(urlset(['https://a.example/1', 'last tuesday']));
      expect(urls).toEqual([{ loc: 'https://a.example/1', lastmodRaw: 'last tuesday' }]);
    });

    it('is case-insensitive on element names', () => {
      const xml = `<URLSET><URL><LOC>https://a.example/1</LOC></URL></URLSET>`;
      expect(parseSitemapXml(xml).urls).toEqual([{ loc: 'https://a.example/1' }]);
    });

    it.each([
      ['empty', ''],
      ['html', '<!doctype html><html><body><a href="/offers/1">x</a><url><loc>nope</loc></url></body></html>'],
      ['json', '{"urls":["https://a.example/1"]}'],
      ['garbage', '\u0000\u0001 <<< >>> &&&'],
      ['empty urlset', `<urlset xmlns="${NS}"></urlset>`],
      ['url outside urlset', '<url><loc>https://a.example/1</loc></url>'],
    ])('returns empty lists for %s', (_label, xml) => {
      expect(parseSitemapXml(xml)).toEqual({ urls: [], sitemaps: [] });
    });

    it('returns empty lists for non-strings', () => {
      expect(parseSitemapXml(undefined as unknown as string)).toEqual({ urls: [], sitemaps: [] });
    });

    it('keeps complete entries of a truncated document', () => {
      const xml = `<urlset xmlns="${NS}"><url><loc>https://a.example/1</loc></url><url><loc>https://a.example/2</loc><lastm`;
      expect(parseSitemapXml(xml).urls.map((u) => u.loc)).toEqual(['https://a.example/1', 'https://a.example/2']);
    });

    it('tolerates a stray close tag', () => {
      const xml = `<urlset xmlns="${NS}"></bogus><url><loc>https://a.example/1</loc></url></urlset>`;
      expect(parseSitemapXml(xml).urls).toEqual([{ loc: 'https://a.example/1' }]);
    });

    it('parses a large urlset quickly', () => {
      const many = Array.from({ length: 50_000 }, (_, i) => [`https://a.example/p/${i}`, '2026-09-24'] as [string, string]);
      const xml = urlset(...many);
      const started = Date.now();
      const { urls } = parseSitemapXml(xml);
      expect(urls).toHaveLength(50_000);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    describe('hostile input stays linear (no event-loop freeze)', () => {
      const MB = 1024 * 1024;

      it.each([
        ['endless nesting + stray close tags', () => '<a>'.repeat(MB / 6) + '</z>'.repeat(MB / 8)],
        ['endless nesting closed in order', () => '<a>'.repeat(MB / 8) + '</a>'.repeat(MB / 8)],
        ['declarations without an internal subset', () => '<!a>'.repeat(MB / 4)],
        ['declarations with brackets far away', () => '<!a>'.repeat(MB / 8) + '['],
      ])('%s (1 MB) parses in well under a second', (_label, build) => {
        const xml = build();
        const started = Date.now();
        const result = parseSitemapXml(xml);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(result.urls).toEqual([]);
      });

      it('entries inside a legit document still parse after an over-deep subtree', () => {
        const deep = '<x>'.repeat(100) + '</x>'.repeat(100);
        const xml = `<urlset xmlns="${NS}">${deep}<url><loc>https://a.example/1</loc></url></urlset>`;
        expect(parseSitemapXml(xml).urls).toEqual([{ loc: 'https://a.example/1' }]);
      });

      it('SITEMAP_MAX_ELEMENT_DEPTH is well above real sitemap nesting', () => {
        expect(SITEMAP_MAX_ELEMENT_DEPTH).toBeGreaterThanOrEqual(16);
      });
    });
  });

  describe('parseSitemapText', () => {
    it('reads one absolute URL per line', () => {
      expect(parseSitemapText('https://a.example/1\r\n\n  http://a.example/2  \nnot a url\n/relative\n')).toEqual([
        { loc: 'https://a.example/1' },
        { loc: 'http://a.example/2' },
      ]);
      expect(parseSitemapText('')).toEqual([]);
    });
  });

  describe('sortSitemapEntriesByLastmod', () => {
    it('newest first, undefined last, stable, non-mutating', () => {
      const entries = [
        { loc: 'none-1' },
        { loc: 'old', lastmod: new Date('2026-01-01T00:00:00Z') },
        { loc: 'tie-a', lastmod: new Date('2026-05-01T00:00:00Z') },
        { loc: 'none-2' },
        { loc: 'new', lastmod: new Date('2026-09-01T00:00:00Z') },
        { loc: 'tie-b', lastmod: new Date('2026-05-01T00:00:00Z') },
        { loc: 'invalid', lastmod: new Date('nope') },
      ];
      const sorted = sortSitemapEntriesByLastmod(entries);
      expect(sorted.map((e) => e.loc)).toEqual(['new', 'tie-a', 'tie-b', 'old', 'none-1', 'none-2', 'invalid']);
      expect(entries[0].loc).toBe('none-1');
    });
  });

  describe('decodeSitemapBody', () => {
    const xml = urlset(['https://a.example/1']);

    it('passes strings through and strips a BOM', () => {
      expect(decodeSitemapBody(xml)).toBe(xml);
      expect(decodeSitemapBody(`﻿${xml}`)).toBe(xml);
    });

    it('decodes Buffer / ArrayBuffer / Uint8Array as UTF-8', () => {
      const buf = Buffer.from(`﻿${xml}é`, 'utf8');
      expect(decodeSitemapBody(buf)).toBe(`${xml}é`);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      expect(decodeSitemapBody(ab)).toBe(`${xml}é`);
      expect(decodeSitemapBody(new Uint8Array(buf))).toBe(`${xml}é`);
    });

    it('gunzips by magic bytes', () => {
      expect(decodeSitemapBody(gzipSync(Buffer.from(xml)))).toBe(xml);
      // A gzip body delivered as a latin1 string (e.g. by a text-mode transport).
      expect(decodeSitemapBody(gzipSync(Buffer.from(xml)).toString('latin1'))).toBe(xml);
    });

    it('decodes UTF-16 with a BOM', () => {
      const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
      expect(decodeSitemapBody(le)).toBe(xml);
      const beBody = Buffer.from(xml, 'utf16le');
      beBody.swap16();
      const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
      expect(decodeSitemapBody(be)).toBe(xml);
    });

    it('enforces the size cap before and after gunzip', () => {
      expect(() => decodeSitemapBody('x'.repeat(101), 100)).toThrow(/exceeds 100 bytes/);
      expect(() => decodeSitemapBody(Buffer.alloc(101, 0x61), 100)).toThrow(/exceeds 100 bytes/);
      const bomb = gzipSync(Buffer.alloc(10_000, 0x61));
      expect(bomb.length).toBeLessThan(100);
      expect(() => decodeSitemapBody(bomb, 100)).toThrow(/after gunzip/);
    });

    it('rejects corrupt gzip', () => {
      expect(() => decodeSitemapBody(Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]))).toThrow(/not valid gzip/);
    });

    it('returns an empty string for null / unknown shapes', () => {
      expect(decodeSitemapBody(null)).toBe('');
      expect(decodeSitemapBody(undefined)).toBe('');
      expect(decodeSitemapBody({ some: 'object' })).toBe('');
    });

    it('defaults to a 10 MB cap', () => {
      expect(SITEMAP_DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('fetchSitemap', () => {
    const ROOT = 'https://a.example/sitemap.xml';

    it('GETs through the given client as arraybuffer with an XML Accept and a size cap', async () => {
      const { http, calls } = fakeHttp({ [ROOT]: urlset(['https://a.example/1']) });
      const entries = await fetchSitemap(http, ROOT);
      expect(entries).toEqual([{ loc: 'https://a.example/1' }]);
      expect(calls).toHaveLength(1);
      expect(calls[0].config).toMatchObject({
        responseType: 'arraybuffer',
        maxContentLength: SITEMAP_DEFAULT_MAX_BYTES,
        headers: { Accept: expect.stringContaining('application/xml') },
      });
    });

    it('merges requestConfig (headers included)', async () => {
      const { http, calls } = fakeHttp({ [ROOT]: urlset(['https://a.example/1']) });
      await fetchSitemap(http, ROOT, { requestConfig: { timeout: 5, headers: { 'X-Test': '1' } }, maxBytes: 500 });
      expect(calls[0].config).toMatchObject({
        timeout: 5,
        responseType: 'arraybuffer',
        maxContentLength: 500,
        headers: { 'X-Test': '1', Accept: expect.any(String) },
      });
    });

    it('follows a sitemapindex breadth-first, gz children included', async () => {
      const { http, calls } = fakeHttp({
        [ROOT]: sitemapIndex('https://a.example/s1.xml', 'https://a.example/s2.xml.gz'),
        'https://a.example/s1.xml': urlset(['https://a.example/1', '2026-09-01']),
        'https://a.example/s2.xml.gz': gzipSync(Buffer.from(urlset(['https://a.example/2', '2026-09-02']))),
      });
      const entries = await fetchSitemap(http, ROOT);
      expect(entries.map((e) => e.loc)).toEqual(['https://a.example/1', 'https://a.example/2']);
      expect(calls.map((c) => c.url)).toEqual([ROOT, 'https://a.example/s1.xml', 'https://a.example/s2.xml.gz']);
    });

    it('decompresses a gzip body even when the URL does not end in .gz', async () => {
      const { http } = fakeHttp({ [ROOT]: gzipSync(Buffer.from(urlset(['https://a.example/z']))) });
      expect((await fetchSitemap(http, ROOT)).map((e) => e.loc)).toEqual(['https://a.example/z']);
    });

    it('stops at maxDepth (default 2 index hops)', async () => {
      const routes = {
        [ROOT]: sitemapIndex('https://a.example/d1.xml'),
        'https://a.example/d1.xml': sitemapIndex('https://a.example/d2.xml'),
        'https://a.example/d2.xml': sitemapIndex('https://a.example/d3.xml'),
        'https://a.example/d3.xml': urlset(['https://a.example/deep']),
      };
      const a = fakeHttp({ ...routes, 'https://a.example/d2.xml': urlset(['https://a.example/at-2']) });
      expect((await fetchSitemap(a.http, ROOT)).map((e) => e.loc)).toEqual(['https://a.example/at-2']);

      const b = fakeHttp(routes);
      expect(await fetchSitemap(b.http, ROOT)).toEqual([]);
      expect(b.calls.map((c) => c.url)).not.toContain('https://a.example/d3.xml');

      const c = fakeHttp(routes);
      expect((await fetchSitemap(c.http, ROOT, { maxDepth: 3 })).map((e) => e.loc)).toEqual(['https://a.example/deep']);

      const root = fakeHttp(routes);
      await fetchSitemap(root.http, ROOT, { maxDepth: 0 });
      expect(root.calls).toHaveLength(1);
    });

    it('caps the number of documents fetched (maxSitemaps, root included)', async () => {
      const children = Array.from({ length: 30 }, (_, i) => `https://a.example/s${i}.xml`);
      const routes: Record<string, string> = { [ROOT]: sitemapIndex(...children) };
      children.forEach((c, i) => (routes[c] = urlset([`https://a.example/p${i}`])));
      const def = fakeHttp(routes);
      const entries = await fetchSitemap(def.http, ROOT);
      expect(def.calls).toHaveLength(20);
      expect(entries).toHaveLength(19);

      const small = fakeHttp(routes);
      await fetchSitemap(small.http, ROOT, { maxSitemaps: 3 });
      expect(small.calls).toHaveLength(3);
    });

    it('caps entries at maxUrls (and stops fetching once reached)', async () => {
      const { http, calls } = fakeHttp({
        [ROOT]: sitemapIndex('https://a.example/s1.xml', 'https://a.example/s2.xml'),
        'https://a.example/s1.xml': urlset(['https://a.example/1'], ['https://a.example/2'], ['https://a.example/3']),
        'https://a.example/s2.xml': urlset(['https://a.example/4']),
      });
      const entries = await fetchSitemap(http, ROOT, { maxUrls: 2 });
      expect(entries.map((e) => e.loc)).toEqual(['https://a.example/1', 'https://a.example/2']);
      expect(calls.map((c) => c.url)).not.toContain('https://a.example/s2.xml');
    });

    it('applies the filter before counting maxUrls', async () => {
      const { http } = fakeHttp({
        [ROOT]: urlset(['https://a.example/'], ['https://a.example/offers/1'], ['https://a.example/about'], ['https://a.example/offers/2']),
      });
      const entries = await fetchSitemap(http, ROOT, { maxUrls: 2, filter: (loc) => /\/offers\/\d+$/.test(loc) });
      expect(entries.map((e) => e.loc)).toEqual(['https://a.example/offers/1', 'https://a.example/offers/2']);
    });

    it('sorts newest lastmod first when asked (undefined last, stable)', async () => {
      const { http } = fakeHttp({
        [ROOT]: urlset(
          ['https://a.example/none'],
          ['https://a.example/old', '2026-01-01 00:00:00'],
          ['https://a.example/new', '2026-09-24 10:00:00'],
          ['https://a.example/mid-a', '2026-05-01'],
          ['https://a.example/mid-b', '2026-05-01T00:00:00Z'],
        ),
      });
      const sorted = await fetchSitemap(http, ROOT, { sortByLastmod: true });
      expect(sorted.map((e) => e.loc.replace('https://a.example/', ''))).toEqual(['new', 'mid-a', 'mid-b', 'old', 'none']);
      const unsorted = await fetchSitemap(http, ROOT);
      expect(unsorted[0].loc).toBe('https://a.example/none');
    });

    it('dedupes locs across documents, keeping the newest lastmod', async () => {
      const { http } = fakeHttp({
        [ROOT]: sitemapIndex('https://a.example/s1.xml', 'https://a.example/s2.xml'),
        'https://a.example/s1.xml': urlset(['https://a.example/1', '2026-01-01'], ['https://a.example/2', '2026-09-01']),
        'https://a.example/s2.xml': urlset(['https://a.example/1', '2026-02-01'], ['https://a.example/2', '2026-08-01']),
      });
      const entries = await fetchSitemap(http, ROOT);
      expect(entries.map((e) => [e.loc, e.lastmodRaw])).toEqual([
        ['https://a.example/1', '2026-02-01'],
        ['https://a.example/2', '2026-09-01'],
      ]);
    });

    it('never fetches a document twice (cycles)', async () => {
      const { http, calls } = fakeHttp({
        [ROOT]: sitemapIndex(ROOT, 'https://a.example/s1.xml'),
        'https://a.example/s1.xml': sitemapIndex(ROOT, 'https://a.example/s1.xml'),
      });
      await fetchSitemap(http, ROOT, { maxDepth: 5 });
      expect(calls.map((c) => c.url)).toEqual([ROOT, 'https://a.example/s1.xml']);
    });

    it('resolves relative locs against the document URL', async () => {
      const { http } = fakeHttp({
        [ROOT]: sitemapIndex('/nested/s1.xml'),
        'https://a.example/nested/s1.xml': urlset(['page-1'], ['/offers/2'], ['https://b.example/abs']),
      });
      const entries = await fetchSitemap(http, ROOT);
      expect(entries.map((e) => e.loc)).toEqual([
        'https://a.example/nested/page-1',
        'https://a.example/offers/2',
        'https://b.example/abs',
      ]);
    });

    it('accepts a plain-text sitemap', async () => {
      const { http } = fakeHttp({ [ROOT]: 'https://a.example/1\nhttps://a.example/2\n' });
      expect((await fetchSitemap(http, ROOT)).map((e) => e.loc)).toEqual(['https://a.example/1', 'https://a.example/2']);
    });

    it('returns [] for an unparseable or empty root document', async () => {
      for (const body of ['', '<html><body>Not a sitemap</body></html>', 'garbage', `<urlset xmlns="${NS}"/>`]) {
        const { http } = fakeHttp({ [ROOT]: body });
        expect(await fetchSitemap(http, ROOT)).toEqual([]);
      }
    });

    it('throws root-document errors (e.g. 404) to the caller', async () => {
      const { http } = fakeHttp({});
      await expect(fetchSitemap(http, ROOT)).rejects.toThrow(/404/);
    });

    it('throws when the root body exceeds maxBytes', async () => {
      const { http } = fakeHttp({ [ROOT]: urlset(['https://a.example/1']) });
      await expect(fetchSitemap(http, ROOT, { maxBytes: 10 })).rejects.toThrow(/exceeds 10 bytes/);
    });

    it('skips a failing nested sitemap, reporting it to onError', async () => {
      const boom = new Error('socket hang up');
      const { http } = fakeHttp({
        [ROOT]: sitemapIndex('https://a.example/missing.xml', 'https://a.example/boom.xml', 'https://a.example/ok.xml'),
        'https://a.example/boom.xml': boom,
        'https://a.example/ok.xml': urlset(['https://a.example/1']),
      });
      const onError = jest.fn();
      const entries = await fetchSitemap(http, ROOT, { onError });
      expect(entries.map((e) => e.loc)).toEqual(['https://a.example/1']);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError.mock.calls.map((c) => c[0])).toEqual(['https://a.example/missing.xml', 'https://a.example/boom.xml']);
      expect(onError.mock.calls[1][1]).toBe(boom);
      // Without onError it still skips quietly.
      await expect(fetchSitemap(http, ROOT)).resolves.toHaveLength(1);
    });

    describe('nested sitemaps outside the root\'s scope', () => {
      const routes = () => ({
        [ROOT]: sitemapIndex(
          'https://a.example/same-host.xml',
          'https://cdn.a.example/same-domain.xml',
          'https://evil.example/other.xml',
          'ftp://a.example/not-http.xml',
        ),
        'https://a.example/same-host.xml': urlset(['https://a.example/1']),
        'https://cdn.a.example/same-domain.xml': urlset(['https://a.example/2']),
        'https://evil.example/other.xml': urlset(['https://a.example/3']),
      });

      it('default same-domain: follows the root domain, skips (and reports) other domains and non-http', async () => {
        const { http, calls } = fakeHttp(routes());
        const onError = jest.fn();
        const entries = await fetchSitemap(http, ROOT, { onError });
        expect(entries.map((e) => e.loc).sort()).toEqual(['https://a.example/1', 'https://a.example/2']);
        expect(calls.map((c) => c.url)).not.toContain('https://evil.example/other.xml');
        expect(onError.mock.calls.map((c) => c[0])).toEqual(['https://evil.example/other.xml', 'ftp://a.example/not-http.xml']);
      });

      it('same-host and any', async () => {
        const sameHost = await fetchSitemap(fakeHttp(routes()).http, ROOT, { nestedScope: 'same-host' });
        expect(sameHost.map((e) => e.loc)).toEqual(['https://a.example/1']);
        const any = await fetchSitemap(fakeHttp(routes()).http, ROOT, { nestedScope: 'any' });
        expect(any.map((e) => e.loc).sort()).toEqual(['https://a.example/1', 'https://a.example/2', 'https://a.example/3']);
      });
    });

    it('ignores invalid numeric options (falls back to defaults)', async () => {
      const { http, calls } = fakeHttp({ [ROOT]: urlset(['https://a.example/1']) });
      const entries = await fetchSitemap(http, ROOT, { maxUrls: -1, maxDepth: Number.NaN, maxSitemaps: 0, maxBytes: -5 });
      expect(entries).toHaveLength(1);
      expect(calls[0].config.maxContentLength).toBe(SITEMAP_DEFAULT_MAX_BYTES);
    });
  });
});
