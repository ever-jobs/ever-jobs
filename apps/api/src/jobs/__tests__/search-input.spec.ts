import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SITE_CATEGORIES, ScraperInputDto } from '@ever-jobs/models';
import {
  clampResultsWanted,
  describeTerm,
  isListMode,
  normalizeSearchInput,
  normalizeSearchTerm,
  parseSiteCategories,
} from '../search-input';

/**
 * Spec 1720 — list-mode input normalisation and `siteCategories` validation.
 */
describe('search-input (Spec 1720)', () => {
  describe('normalizeSearchTerm', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ['spaces', '   '],
      ['tabs and newlines', '\t\n  '],
      ['a number (non-string)', 42],
    ])('%s → undefined (list mode)', (_label, value) => {
      expect(normalizeSearchTerm(value)).toBeUndefined();
    });

    it('trims a real keyword', () => {
      expect(normalizeSearchTerm('  node developer  ')).toBe('node developer');
    });
  });

  describe('normalizeSearchInput', () => {
    it('deletes an empty keyword so the input serialises like one that never sent it', () => {
      const withEmpty = normalizeSearchInput({ searchTerm: '  ', location: 'NYC' } as ScraperInputDto);
      const without = { location: 'NYC' };
      expect('searchTerm' in withEmpty).toBe(false);
      expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(without));
    });

    it('deletes null, and never leaves the strings "null" / "undefined"', () => {
      const input = normalizeSearchInput({
        searchTerm: null,
        googleSearchTerm: '',
      } as unknown as ScraperInputDto);
      expect(input).toEqual({});
      expect(JSON.stringify(input)).not.toMatch(/null|undefined/);
    });

    it('trims both keyword fields in place and is idempotent', () => {
      const input = { searchTerm: ' rust ', googleSearchTerm: ' rust jobs ' } as ScraperInputDto;
      normalizeSearchInput(input);
      normalizeSearchInput(input);
      expect(input).toEqual({ searchTerm: 'rust', googleSearchTerm: 'rust jobs' });
    });

    it('leaves an input without keyword fields untouched', () => {
      const input = { location: 'Berlin' } as ScraperInputDto;
      expect(normalizeSearchInput(input)).toEqual({ location: 'Berlin' });
    });
  });

  describe('isListMode / describeTerm', () => {
    it('reports list mode and <none> for every empty spelling', () => {
      for (const searchTerm of [undefined, null, '', '   ']) {
        const input = { searchTerm } as unknown as ScraperInputDto;
        expect(isListMode(input)).toBe(true);
        expect(describeTerm(input)).toBe('<none>');
      }
    });

    it('quotes a real keyword', () => {
      const input = { searchTerm: ' go ' } as ScraperInputDto;
      expect(isListMode(input)).toBe(false);
      expect(describeTerm(input)).toBe('"go"');
    });
  });

  describe('parseSiteCategories', () => {
    it('absent or empty → no narrowing', () => {
      expect(parseSiteCategories(undefined)).toBeUndefined();
      expect(parseSiteCategories(null)).toBeUndefined();
      expect(parseSiteCategories([])).toBeUndefined();
    });

    it('returns the de-duplicated set of known categories', () => {
      const set = parseSiteCategories(['job-board', 'remote', 'job-board']);
      expect([...set!].sort()).toEqual(['job-board', 'remote']);
    });

    it('accepts every declared category', () => {
      expect(parseSiteCategories([...SITE_CATEGORIES])!.size).toBe(SITE_CATEGORIES.length);
    });

    it('rejects an unknown value with a 400 naming it and the allowed list', () => {
      let caught: unknown;
      try {
        parseSiteCategories(['job-board', 'boards']);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const message = (caught as BadRequestException).message;
      expect(message).toContain('"boards"');
      for (const category of SITE_CATEGORIES) expect(message).toContain(category);
    });

    it('is case-sensitive, like plugin metadata', () => {
      expect(() => parseSiteCategories(['Company'])).toThrow(BadRequestException);
    });

    it('rejects a non-array', () => {
      expect(() => parseSiteCategories('company')).toThrow(BadRequestException);
    });
  });

  describe('ScraperInputDto.siteCategories validation (ValidationPipe path → 400)', () => {
    async function errorsFor(body: Record<string, unknown>) {
      const dto = plainToInstance(ScraperInputDto, body);
      return validate(dto, { whitelist: true });
    }

    it('accepts known categories', async () => {
      expect(await errorsFor({ siteCategories: ['job-board', 'company'] })).toEqual([]);
    });

    it('rejects an unknown category with a message listing the allowed values', async () => {
      const errors = await errorsFor({ siteCategories: ['boards'] });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.property).toBe('siteCategories');
      const message = Object.values(errors[0]!.constraints ?? {}).join(' ');
      expect(message).toContain('job-board');
      expect(message).toContain('ats');
    });

    it('rejects a non-array value', async () => {
      const errors = await errorsFor({ siteCategories: 'company' });
      expect(errors.map((e) => e.property)).toContain('siteCategories');
    });

    it('whitelist keeps the field (it is declared on the DTO)', () => {
      const dto = plainToInstance(ScraperInputDto, { siteCategories: ['remote'] });
      expect(dto.siteCategories).toEqual(['remote']);
    });
  });
});

describe('clampResultsWanted (Spec 1720 / FR-12)', () => {
  it('clamps an over-cap value in place and reports what was asked', () => {
    const input = { resultsWanted: 5_000 };
    expect(clampResultsWanted(input, 1_000)).toBe(5_000);
    expect(input.resultsWanted).toBe(1_000);
    // Idempotent: the second call (service after controller) changes nothing.
    expect(clampResultsWanted(input, 1_000)).toBeUndefined();
    expect(input.resultsWanted).toBe(1_000);
  });

  it('clamps Infinity from a caller that bypassed validation', () => {
    const input = { resultsWanted: Number.POSITIVE_INFINITY };
    expect(clampResultsWanted(input, 1_000)).toBe(Number.POSITIVE_INFINITY);
    expect(input.resultsWanted).toBe(1_000);
  });

  it.each([
    ['at the cap', { resultsWanted: 1_000 }, 1_000],
    ['below the cap', { resultsWanted: 15 }, 1_000],
    ['absent', {}, 1_000],
    ['cap disabled (0)', { resultsWanted: 50_000 }, 0],
    ['NaN', { resultsWanted: Number.NaN }, 1_000],
  ])('leaves the input alone when %s', (_label, input: { resultsWanted?: number }, max) => {
    const before = input.resultsWanted;
    expect(clampResultsWanted(input, max)).toBeUndefined();
    expect(input.resultsWanted).toBe(before);
  });
});
