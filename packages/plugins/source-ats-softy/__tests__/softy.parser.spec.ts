import * as fs from 'fs';
import * as path from 'path';

import {
  hasLegacySoftyLinks,
  looksLikeCurrentSoftyMarkup,
  parseSoftyDetailPage,
  parseSoftyListingPage,
  softyListingPageUrl,
  softyOfferIdFromUrl,
  softyOfferUrl,
} from '../src/softy.parser';
import { readSoftyConfig } from '../src/softy.config';
import {
  SOFTY_DESCRIPTION_MAX_CHARS,
  SOFTY_DETAIL_CACHE_MAX,
  SOFTY_DETAIL_CACHE_TTL_MS,
  SOFTY_MAX_DETAIL_FETCHES,
  SOFTY_MAX_LIST_PAGES,
} from '../src/softy.constants';
import * as barrel from '../src';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const detailHtml = (id: string, title: string) =>
  fixture('detail.html').replace(/__ID__/g, id).replace(/__TITLE__/g, title);

describe('Softy parsers (Spec 1691)', () => {
  it('builds canonical URLs', () => {
    expect(softyOfferUrl('acme', '1001')).toBe('https://acme.softy.pro/offers/1001');
    expect(softyListingPageUrl('acme', 3)).toBe('https://acme.softy.pro/offers?page=3');
  });

  it('exports the parsers, config and constants from the package barrel', () => {
    expect(barrel.parseSoftyListingPage).toBe(parseSoftyListingPage);
    expect(barrel.readSoftyConfig).toBe(readSoftyConfig);
    expect(typeof barrel.SOFTY_BROWSER_USER_AGENT).toBe('string');
    expect(barrel.SoftyService).toBeDefined();
  });

  describe('softyOfferIdFromUrl', () => {
    it.each([
      ['https://acme.softy.pro/offers/1001', '1001'],
      ['https://acme.softy.pro/offers/1001/', '1001'],
      ['https://ACME.softy.pro/offers/1001', '1001'],
      ['/offers/1001', '1001'],
      ['/fr/offers/1001', '1001'],
      ['https://acme.softy.pro/offers/1001?utm=x', '1001'],
      ['https://acme.softy.pro/offers/1001/apply', null],
      ['https://acme.softy.pro/offers?page=2', null],
      ['https://acme.softy.pro/offers', null],
      ['https://other.softy.pro/offers/1001', null],
      ['https://acme.softy.pro/offre/1001-dev', null],
      ['https://acme.softy.pro/offers/abc', null],
      ['', null],
      [undefined, null],
    ])('%j → %j', (url, id) => {
      expect(softyOfferIdFromUrl(url as string | undefined, 'acme.softy.pro')).toBe(id);
    });
  });

  describe('parseSoftyListingPage', () => {
    it('parses the current card markup', () => {
      const { cards, pages } = parseSoftyListingPage(fixture('listing-page-1.html'), 'acme');
      expect(pages).toEqual([1, 2]);
      expect(cards).toHaveLength(3);
      expect(cards[0]).toEqual({
        id: '1001',
        url: 'https://acme.softy.pro/offers/1001',
        title: 'Développeur Full-Stack - H/F',
        location: 'Toulouse',
        locations: ['Toulouse'],
        contractType: 'CDI',
        schedule: 'Temps plein',
        badges: ['CDI', 'Temps plein'],
        publishedAt: 'Mise en ligne le 20/09/2026',
      });
      expect(cards[1]).toMatchObject({
        id: '1002',
        title: 'Chef de projet & PMO - H/F',
        contractType: 'CDD - 6 Mois',
        schedule: 'Temps partiel',
      });
      expect(cards[2]).toMatchObject({ id: '1003', contractType: 'Apprentissage - 24 Mois', schedule: null });
    });

    it('resolves relative hrefs and ignores a disabled "next" link', () => {
      const { cards, pages } = parseSoftyListingPage(fixture('listing-page-2.html'), 'acme');
      expect(cards.map((c) => c.id)).toEqual(['1004', '1005']);
      expect(cards[1].url).toBe('https://acme.softy.pro/offers/1005');
      expect(pages).toEqual([1, 2]);
    });

    it('finds the card fields when the anchor does not wrap them', () => {
      const html = `<div class="card"><a href="/offers/7"><span>Voir</span></a>
          <h3 data-slot="joboffer-title">Titre</h3>
          <div data-slot="joboffer-locations"><p>Rennes</p><p>Brest</p></div>
          <span data-slot="badge">CDI</span></div>
        <div class="card"><a href="/offers/8">Autre offre</a><a href="/offers/8">Postuler</a></div>`;
      const { cards } = parseSoftyListingPage(html, 'acme');
      expect(cards[0]).toMatchObject({ id: '7', title: 'Titre', location: 'Rennes', locations: ['Rennes', 'Brest'], contractType: 'CDI' });
      expect(cards[1]).toMatchObject({ id: '8', title: 'Autre offre', locations: [] });
    });

    it('does not borrow fields from a neighbouring card', () => {
      const html = `<div class="list">
          <a href="/offers/1">Un</a>
          <a href="/offers/2">Deux</a>
          <h3 data-slot="joboffer-title">Shared heading</h3>
        </div>`;
      const { cards } = parseSoftyListingPage(html, 'acme');
      expect(cards.map((c) => [c.id, c.title])).toEqual([
        ['1', 'Un'],
        ['2', 'Deux'],
      ]);
    });

    it('returns nothing for empty / foreign markup', () => {
      expect(parseSoftyListingPage('', 'acme')).toEqual({ cards: [], pages: [] });
      expect(parseSoftyListingPage(fixture('listing-empty.html'), 'acme')).toEqual({ cards: [], pages: [] });
      expect(parseSoftyListingPage(fixture('legacy-offres.html'), 'legacy').cards).toEqual([]);
    });
  });

  describe('parseSoftyDetailPage', () => {
    it('extracts title, locations, badges and the .prose sections with their headings', () => {
      const detail = parseSoftyDetailPage(detailHtml('1001', 'Développeur Full-Stack - H/F'));
      expect(detail).toMatchObject({
        title: 'Développeur Full-Stack - H/F',
        locations: ['Toulouse'],
        contractType: 'CDI',
        schedule: 'Temps plein',
        badges: ['Contract management', 'TypeScript', 'CDI', 'Temps plein', 'Expérience exigée'],
        publishedAt: null,
        descriptionIsHtml: true,
      });
      const html = detail?.description ?? '';
      expect(html).toContain("<h2>L'entreprise</h2>");
      expect(html).toContain('<h2>Vos missions</h2>');
      expect(html).toContain('<h2>Profil recherché</h2>');
      expect(html).toContain('<li>Concevoir des API</li>');
      expect(html).toContain('<strong>ACME</strong> conçoit des logiciels &amp; services.');
      expect(html).toContain('href="https://acme.example/about"');
      expect(html).not.toMatch(/class=|style=|onclick|javascript:|<script|<button|not the description|alert/);
      // Headings of non-.prose sections are not part of the description.
      expect(html).not.toContain('Compétences requises');
    });

    it('falls back to og:title / <title> for the title', () => {
      const noH1 = detailHtml('1', 'Titre').replace(/<h1[^>]*>.*?<\/h1>/, '');
      expect(parseSoftyDetailPage(noH1)?.title).toBe('Titre - ACME');
      const bare = '<html><head><title> Seul titre </title></head><body><p>x</p></body></html>';
      expect(parseSoftyDetailPage(bare)?.title).toBe('Seul titre');
    });

    it('falls back to og:description, then to the page text (legacy)', () => {
      const noProse = detailHtml('1', 'Titre').replace(/class="prose[^"]*"/g, 'class="x"');
      expect(parseSoftyDetailPage(noProse)).toMatchObject({
        description: 'Rejoignez ACME en tant que Titre.',
        descriptionIsHtml: false,
      });
      const legacy = parseSoftyDetailPage(fixture('legacy-detail.html'));
      expect(legacy?.descriptionIsHtml).toBe(false);
      expect(legacy?.description).toContain('Nous recherchons un manager IT pour piloter le poste de travail.');
      expect(legacy?.description).toContain('\n');
      expect(legacy?.description).not.toContain('do not keep');
    });

    it('keeps one heading per h2 and ignores nested .prose', () => {
      const html = `<main><h2>Mission</h2><div class="prose"><p>A</p><div class="prose"><p>B</p></div></div>
        <div class="prose"><p>C</p></div></main>`;
      const d = parseSoftyDetailPage(html);
      expect(d?.description).toBe('<h2>Mission</h2><p>A</p><p>B</p><p>C</p>');
    });

    it('does not add a heading when the section starts with its own', () => {
      const d = parseSoftyDetailPage('<h2>Outer</h2><div class="prose"><h3>Inner</h3><p>x</p></div>');
      expect(d?.description).toBe('<h3>Inner</h3><p>x</p>');
    });

    it('caps the description at the limit on block boundaries', () => {
      const para = `<p>${'Lorem ipsum dolor sit amet. '.repeat(10)}</p>`;
      const html = `<h2>Big</h2><div class="prose">${para.repeat(100)}</div>`;
      const d = parseSoftyDetailPage(html);
      expect(d?.description?.length).toBeLessThanOrEqual(SOFTY_DESCRIPTION_MAX_CHARS);
      expect(d?.description?.endsWith('</p>')).toBe(true);
      expect(d?.description?.startsWith('<h2>Big</h2>')).toBe(true);
    });

    it('truncates a single oversized block to text within the limit', () => {
      const html = `<div class="prose"><p>${'x & y '.repeat(3000)}</p></div>`;
      const d = parseSoftyDetailPage(html);
      expect(d?.description?.length).toBeLessThanOrEqual(SOFTY_DESCRIPTION_MAX_CHARS);
      expect(d?.description).toMatch(/^<p>x &amp; y/);
      expect(d?.description?.endsWith('</p>')).toBe(true);
    });

    it('caps the plain-text fallbacks too', () => {
      const d = parseSoftyDetailPage(`<body><p>${'z'.repeat(20000)}</p></body>`);
      expect(d?.description?.length).toBe(SOFTY_DESCRIPTION_MAX_CHARS);
    });

    it('returns null for an empty page', () => {
      expect(parseSoftyDetailPage('')).toBeNull();
      expect(parseSoftyDetailPage('   ')).toBeNull();
      expect(parseSoftyDetailPage('<html><body></body></html>')).toBeNull();
    });
  });

  it('tells legacy markup from an empty current board', () => {
    expect(hasLegacySoftyLinks(fixture('legacy-offres.html'))).toBe(true);
    expect(hasLegacySoftyLinks(fixture('listing-page-1.html'))).toBe(false);
    expect(looksLikeCurrentSoftyMarkup(fixture('listing-empty.html'))).toBe(true);
    expect(looksLikeCurrentSoftyMarkup(fixture('legacy-offres.html'))).toBe(false);
  });
});

describe('readSoftyConfig (Spec 1691)', () => {
  it('defaults to the constants', () => {
    expect(readSoftyConfig({})).toEqual({
      maxListPages: SOFTY_MAX_LIST_PAGES,
      maxDetailFetches: SOFTY_MAX_DETAIL_FETCHES,
      detailCacheMax: SOFTY_DETAIL_CACHE_MAX,
      detailCacheTtlMs: SOFTY_DETAIL_CACHE_TTL_MS,
      lastmodAsDatePosted: true,
      maxConsecutiveDetailFailures: 3,
    });
    expect(SOFTY_MAX_LIST_PAGES).toBe(50);
    expect(SOFTY_MAX_DETAIL_FETCHES).toBe(100);
    expect(SOFTY_DETAIL_CACHE_MAX).toBe(500);
    expect(SOFTY_DETAIL_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('reads every override from the environment', () => {
    expect(
      readSoftyConfig({
        SOFTY_MAX_LIST_PAGES: '7',
        SOFTY_MAX_DETAIL_FETCHES: '0',
        SOFTY_DETAIL_CACHE_MAX: ' 20 ',
        SOFTY_DETAIL_CACHE_TTL_MS: '0',
        SOFTY_LASTMOD_AS_DATE_POSTED: 'off',
        SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES: '0',
      }),
    ).toEqual({
      maxListPages: 7,
      maxDetailFetches: 0,
      detailCacheMax: 20,
      detailCacheTtlMs: 0,
      lastmodAsDatePosted: false,
      maxConsecutiveDetailFailures: 0,
    });
  });

  it.each(['true', '1', 'yes', 'ON'])('accepts %j as true', (v) => {
    expect(readSoftyConfig({ SOFTY_LASTMOD_AS_DATE_POSTED: v }).lastmodAsDatePosted).toBe(true);
  });

  it('ignores invalid values', () => {
    const cfg = readSoftyConfig({
      SOFTY_MAX_LIST_PAGES: '0',
      SOFTY_MAX_DETAIL_FETCHES: '-1',
      SOFTY_DETAIL_CACHE_MAX: 'lots',
      SOFTY_DETAIL_CACHE_TTL_MS: '1.5',
      SOFTY_LASTMOD_AS_DATE_POSTED: 'maybe',
      SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES: '',
    });
    expect(cfg).toEqual(readSoftyConfig({}));
  });

  it('reads process.env by default', () => {
    const prev = process.env.SOFTY_MAX_LIST_PAGES;
    process.env.SOFTY_MAX_LIST_PAGES = '3';
    try {
      expect(readSoftyConfig().maxListPages).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.SOFTY_MAX_LIST_PAGES;
      else process.env.SOFTY_MAX_LIST_PAGES = prev;
    }
  });
});
