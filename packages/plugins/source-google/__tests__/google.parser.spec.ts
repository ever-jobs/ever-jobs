/**
 * Spec 1704 — pure readers for the Google Jobs page.
 *
 * Fixtures are synthetic, built from the documented record layout; no
 * captured Google page is committed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Site } from '@ever-jobs/models';
import {
  extractBalancedArray,
  extractGoogleCursor,
  findArrayEnd,
  findJobRecords,
  GOOGLE_DEFAULT_MAX_PAGES,
  GOOGLE_HARD_MAX_PAGES,
  GOOGLE_JOB_PAYLOAD_KEYS,
  GOOGLE_LEGACY_PARSER_ENV,
  GOOGLE_MAX_PAGES_ENV,
  googleHashCode,
  googleJobId,
  googleLegacyParserEnabled,
  googleLocation,
  googleMaxPages,
  googleRecordToJobPost,
  isJobRecord,
  looksLikeGoogleInterstitial,
  parseGoogleJobRecords,
} from '../src';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const INITIAL = fixture('google-initial.html');
const ROTATED = fixture('google-initial-rotated-key.html');
const PAGE_2 = fixture('google-page-2.html');
const SORRY = fixture('google-sorry.html');
const ENABLEJS = fixture('google-enablejs.html');
const EMPTY = fixture('google-empty-results.html');

/** A record in the documented layout: title, company, location, links … id at [28]. */
function record(overrides: Partial<Record<number, unknown>> = {}): unknown[] {
  const r: unknown[] = ['Title', 'Company', 'Austin, TX, United States', [['https://example.test/job/1']]];
  while (r.length < 29) r.push(null);
  r[28] = 'stable-1';
  for (const [k, v] of Object.entries(overrides)) r[Number(k)] = v;
  return r;
}

describe('Spec 1704 — google.parser', () => {
  describe('findArrayEnd / extractBalancedArray', () => {
    it('returns the whole balanced array', () => {
      const text = 'x=[1,[2,[3]],4];';
      expect(extractBalancedArray(text, 2)).toBe('[1,[2,[3]],4]');
      expect(findArrayEnd(text, 2)).toBe(text.indexOf(';') - 1);
    });

    it('ignores brackets and escaped quotes inside strings', () => {
      const text = '["a]]]","b\\"]","[[c"],"tail"';
      expect(extractBalancedArray(text, 0)).toBe('["a]]]","b\\"]","[[c"]');
      expect(JSON.parse(extractBalancedArray(text, 0) as string)).toEqual(['a]]]', 'b"]', '[[c']);
    });

    it('returns null for an unterminated array, a non-[ start, an out-of-range start, or past maxChars', () => {
      expect(extractBalancedArray('[1,[2,3]', 0)).toBeNull();
      expect(extractBalancedArray('{"a":[1]}', 0)).toBeNull();
      expect(extractBalancedArray('[1]', 5)).toBeNull();
      expect(extractBalancedArray('[1]', -1)).toBeNull();
      expect(extractBalancedArray('[1,2,3,4,5]', 0, 5)).toBeNull();
      expect(extractBalancedArray('[1,2,3,4,5]', 0, 11)).toBe('[1,2,3,4,5]');
    });
  });

  describe('isJobRecord', () => {
    it('accepts a record as it really starts: with the title string', () => {
      const r = record();
      expect(JSON.stringify(r).startsWith('["')).toBe(true);
      expect(isJobRecord(r)).toBe(true);
    });

    it('rejects short arrays, blank fields, and records without an http(s) URL', () => {
      expect(isJobRecord(['a', 'b', 'c', [['https://x.test']]])).toBe(false);
      expect(isJobRecord(record({ 0: '   ' }))).toBe(false);
      expect(isJobRecord(record({ 1: '' }))).toBe(false);
      expect(isJobRecord(record({ 2: null }))).toBe(false);
      expect(isJobRecord(record({ 3: null }))).toBe(false);
      expect(isJobRecord(record({ 3: [] }))).toBe(false);
      expect(isJobRecord(record({ 3: [['javascript:alert(1)']] }))).toBe(false);
      expect(isJobRecord(record({ 3: [['/relative/path']] }))).toBe(false);
      expect(isJobRecord({ 0: 'a' })).toBe(false);
      expect(isJobRecord(null)).toBe(false);
    });

    it('rejects a [[[-anchored wrapper whose first entry is not a title', () => {
      expect(isJobRecord([[['Title', 'Company']], 'x', 'y', [['https://x.test']], ...Array(20).fill(null)])).toBe(false);
    });

    it('does not require the stable id', () => {
      expect(isJobRecord(record({ 28: null }))).toBe(true);
    });
  });

  describe('findJobRecords', () => {
    it('finds the job-shaped records under the known key and skips the one without a URL', () => {
      const scan = findJobRecords(INITIAL);
      expect(scan.viaFallback).toBe(false);
      expect(scan.keys).toEqual(['520084652']);
      expect(scan.records.map((r) => r[0])).toEqual(['Site Reliability Engineer', 'Backend Developer']);
    });

    it('falls back to any 9-digit key whose value is job-shaped when the known key is absent', () => {
      expect(GOOGLE_JOB_PAYLOAD_KEYS).not.toContain('987654321');
      const scan = findJobRecords(ROTATED);
      expect(scan.viaFallback).toBe(true);
      expect(scan.keys).toEqual(['987654321']);
      expect(scan.records.map((r) => r[0])).toEqual(['Site Reliability Engineer', 'Backend Developer']);
    });

    it('uses the fallback when the known key is present but carries no job-shaped value', () => {
      const text = `{"520084652":["not","a","record"]},{"123456789":${JSON.stringify(record())}}`;
      const scan = findJobRecords(text);
      expect(scan.viaFallback).toBe(true);
      expect(scan.keys).toEqual(['123456789']);
      expect(scan.records).toHaveLength(1);
    });

    it('prefers the known keys: a rotated key is not read when the known key yields records', () => {
      const text = `{"520084652":${JSON.stringify(record({ 0: 'Known' }))}},{"123456789":${JSON.stringify(
        record({ 0: 'Other' }),
      )}}`;
      const scan = findJobRecords(text);
      expect(scan.viaFallback).toBe(false);
      expect(scan.records.map((r) => r[0])).toEqual(['Known']);
    });

    it('does not read a key nested inside an accepted record as a second record', () => {
      const inner = record({ 0: 'Inner' });
      const outer = record({ 0: 'Outer', 20: { 520084652: inner } });
      const scan = findJobRecords(`{"520084652":${JSON.stringify(outer)}}`);
      expect(scan.records.map((r) => r[0])).toEqual(['Outer']);
    });

    it('accepts custom known keys and whitespace around the colon', () => {
      const text = `{"111222333" :  ${JSON.stringify(record({ 0: 'Spaced' }))}}`;
      const scan = findJobRecords(text, { knownKeys: ['111222333'] });
      expect(scan.viaFallback).toBe(false);
      expect(scan.records.map((r) => r[0])).toEqual(['Spaced']);
    });

    it('skips an unterminated or malformed record and keeps going', () => {
      const text = `{"520084652":[1,2,}{"520084652":${JSON.stringify(record({ 0: 'Good' }))}}`;
      expect(findJobRecords(text).records.map((r) => r[0])).toEqual(['Good']);
      expect(findJobRecords(`{"520084652":["open", "never closes"`).records).toEqual([]);
    });

    it('respects the candidate cap, the per-record limit and the page budget', () => {
      const many = Array.from({ length: 5 }, (_, i) => `{"520084652":${JSON.stringify(record({ 0: `T${i}`, 28: `id-${i}` }))}}`).join(',');
      expect(findJobRecords(many).records).toHaveLength(5);
      expect(findJobRecords(many, { maxCandidates: 2 }).records).toHaveLength(2);
      expect(findJobRecords(many, { maxRecordChars: 20 }).records).toHaveLength(0);
      const oneRecordChars = JSON.stringify(record({ 0: 'T0', 28: 'id-0' })).length;
      expect(findJobRecords(many, { maxScanChars: oneRecordChars * 2 + 1 }).records).toHaveLength(2);
    });

    it('returns nothing for empty input, interstitials and a results page without payload', () => {
      for (const text of ['', SORRY, ENABLEJS, EMPTY]) {
        expect(findJobRecords(text)).toEqual({ records: [], keys: [], viaFallback: false });
      }
    });

    it('stays linear on a long run of candidate keys that never close', () => {
      const hostile = '"520084652":['.repeat(20_000);
      const started = Date.now();
      expect(findJobRecords(hostile).records).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  describe('extractGoogleCursor', () => {
    it('reads data-async-fc from the Yust4d element', () => {
      expect(extractGoogleCursor(INITIAL)).toBe('SYNTH_CURSOR_PAGE_2');
    });

    it('does not depend on attribute order or quote style', () => {
      expect(extractGoogleCursor(`<div data-async-fc='C2' class="x" jsname="Yust4d"></div>`)).toBe('C2');
    });

    it('returns null when the element, the attribute or its value is missing', () => {
      expect(extractGoogleCursor(ROTATED)).toBeNull();
      expect(extractGoogleCursor(EMPTY)).toBeNull();
      expect(extractGoogleCursor('')).toBeNull();
      expect(extractGoogleCursor('<div jsname="Yust4d"></div>')).toBeNull();
      expect(extractGoogleCursor('<div jsname="Yust4d" data-async-fc="  "></div>')).toBeNull();
      expect(extractGoogleCursor('<div jsname="Other" data-async-fc="C3"></div>')).toBeNull();
    });
  });

  describe('looksLikeGoogleInterstitial', () => {
    it('flags the unusual-traffic page and the JavaScript-required refresh', () => {
      expect(looksLikeGoogleInterstitial(SORRY)).toBe(true);
      expect(looksLikeGoogleInterstitial(ENABLEJS)).toBe(true);
    });

    it('flags a meta refresh to the JavaScript-required page on its own', () => {
      expect(looksLikeGoogleInterstitial('<meta http-equiv=refresh content="0;url=/x/enablejs">')).toBe(true);
    });

    it('flags a 429 and a final URL on the /sorry/ page', () => {
      expect(looksLikeGoogleInterstitial('', undefined, 429)).toBe(true);
      expect(looksLikeGoogleInterstitial('', 'https://www.google.com/sorry/index?continue=x')).toBe(true);
    });

    it('does not flag real pages', () => {
      expect(looksLikeGoogleInterstitial(INITIAL, 'https://www.google.com/search?q=x', 200)).toBe(false);
      expect(looksLikeGoogleInterstitial(EMPTY)).toBe(false);
      expect(looksLikeGoogleInterstitial('')).toBe(false);
      expect(looksLikeGoogleInterstitial('<meta name="viewport" content="width=device-width">')).toBe(false);
    });
  });

  describe('googleRecordToJobPost', () => {
    it('takes every field from the one record', () => {
      const [acme] = findJobRecords(INITIAL).records;
      const job = googleRecordToJobPost(acme);
      expect(job).not.toBeNull();
      expect(job).toMatchObject({
        id: 'go-job-acme-sre-001',
        title: 'Site Reliability Engineer',
        companyName: 'Acme Corp',
        jobUrl: 'https://jobs.acme.example/postings/sre-001',
        site: Site.GOOGLE,
      });
      expect(job!.location).toMatchObject({ city: 'Austin', state: 'TX', country: 'United States' });
      expect(job!.locations).toHaveLength(1);
      expect(job!.isRemote).toBeUndefined();
    });

    it('produces the same id on every parse', () => {
      const a = parseGoogleJobRecords(INITIAL).jobs.map((j) => j.id);
      const b = parseGoogleJobRecords(INITIAL).jobs.map((j) => j.id);
      expect(a).toEqual(['go-job-acme-sre-001', 'go-job-beta-backend-042']);
      expect(b).toEqual(a);
    });

    it('falls back to a URL hash id only when the record has no stable id', () => {
      const r = record({ 28: null });
      expect(googleJobId(r, 'https://example.test/job/1')).toBe(
        `go-${Math.abs(googleHashCode('https://example.test/job/1'))}`,
      );
      expect(googleRecordToJobPost(r)!.id).toBe(`go-${Math.abs(googleHashCode('https://example.test/job/1'))}`);
      expect(googleJobId(record({ 28: '  s-9 ' }), 'https://x.test')).toBe('go-s-9');
    });

    it('trims title, company and URL', () => {
      const job = googleRecordToJobPost(record({ 0: '  Nurse ', 1: ' Care Co ', 3: [[' https://care.test/1 ']] }));
      expect(job).toMatchObject({ title: 'Nurse', companyName: 'Care Co', jobUrl: 'https://care.test/1' });
    });

    it('returns null for a record that is not job-shaped', () => {
      expect(googleRecordToJobPost(record({ 3: null }))).toBeNull();
      expect(googleRecordToJobPost('nope')).toBeNull();
    });
  });

  describe('googleLocation', () => {
    it('"Anywhere" is remote with no city', () => {
      const where = googleLocation('Anywhere');
      expect(where.isRemote).toBe(true);
      expect(where.workFromHomeType).toBe('Remote');
      expect(where.locations).toEqual([]);
      expect(where.location.city).toBeUndefined();
    });

    it('"Remote" and "Work from home" are remote with no city', () => {
      for (const label of ['Remote', 'work from home', ' WFH ']) {
        const where = googleLocation(label);
        expect(where.isRemote).toBe(true);
        expect(where.location.city).toBeUndefined();
      }
    });

    it('a place with a remote qualifier keeps the place and is remote', () => {
      const where = googleLocation('United States (Remote)');
      expect(where.isRemote).toBe(true);
      expect(where.location.country).toBe('United States');
    });

    it('a plain place is not marked remote', () => {
      const where = googleLocation('Berlin, Germany');
      expect(where.isRemote).toBe(false);
      expect(where.workFromHomeType).toBeNull();
      expect(where.location).toMatchObject({ city: 'Berlin', country: 'Germany' });
    });
  });

  describe('parseGoogleJobRecords', () => {
    it('dedupes rows by id within a page', () => {
      const r = JSON.stringify(record({ 28: 'dup' }));
      const text = `{"520084652":${r}},{"520084652":${r}}`;
      expect(parseGoogleJobRecords(text).jobs).toHaveLength(1);
    });

    it('reads a follow-up page in the same record layout', () => {
      expect(parseGoogleJobRecords(PAGE_2).jobs.map((j) => j.id)).toEqual([
        'go-job-acme-sre-001',
        'go-job-delta-platform-077',
        'go-job-epsilon-qa-005',
      ]);
    });

    it('never emits a synthetic search URL', () => {
      for (const text of [INITIAL, ROTATED, PAGE_2]) {
        for (const job of parseGoogleJobRecords(text).jobs) {
          expect(job.jobUrl).toMatch(/^https?:\/\//);
          expect(job.jobUrl).not.toContain('google.com/search');
        }
      }
    });
  });

  describe('env switches', () => {
    it('legacy parser is off by default and on for true/1/yes/on', () => {
      expect(googleLegacyParserEnabled({})).toBe(false);
      for (const v of ['', 'false', '0', 'no', 'off', 'maybe']) {
        expect(googleLegacyParserEnabled({ [GOOGLE_LEGACY_PARSER_ENV]: v })).toBe(false);
      }
      for (const v of ['true', '1', 'yes', 'on', ' TRUE ']) {
        expect(googleLegacyParserEnabled({ [GOOGLE_LEGACY_PARSER_ENV]: v })).toBe(true);
      }
    });

    it('max pages takes a positive integer and otherwise keeps the default', () => {
      expect(googleMaxPages({})).toBe(GOOGLE_DEFAULT_MAX_PAGES);
      expect(googleMaxPages({ [GOOGLE_MAX_PAGES_ENV]: '3' })).toBe(3);
      expect(googleMaxPages({ [GOOGLE_MAX_PAGES_ENV]: ' 25 ' })).toBe(25);
      // Clamped to the hard ceiling, never unbounded.
      expect(googleMaxPages({ [GOOGLE_MAX_PAGES_ENV]: String(GOOGLE_HARD_MAX_PAGES) })).toBe(GOOGLE_HARD_MAX_PAGES);
      expect(googleMaxPages({ [GOOGLE_MAX_PAGES_ENV]: '1000' })).toBe(GOOGLE_HARD_MAX_PAGES);
      for (const v of ['', '0', '-2', '1.5', 'ten', '99999999999999999999']) {
        expect(googleMaxPages({ [GOOGLE_MAX_PAGES_ENV]: v })).toBe(GOOGLE_DEFAULT_MAX_PAGES);
      }
    });
  });
});
