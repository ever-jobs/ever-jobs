import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ExclusionPreset,
  HARD_MAX_SEARCH_LOCATIONS,
  MAX_EXCLUSION_TERMS,
  MAX_EXCLUSION_TERM_LENGTH,
  MAX_SEARCH_LOCATION_LENGTH,
  ScraperInputDto,
} from '../src';

/**
 * Spec 1700 — `locations`, `excludeTitleTerms`, `excludeKeywords` and
 * `excludePresets` carry class-validator metadata, so the API's global
 * `ValidationPipe({ whitelist: true })` keeps them (an undecorated field is
 * silently stripped) and rejects malformed values with a 400.
 */
async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(ScraperInputDto, body);
  const errors = await validate(dto, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('ScraperInputDto.locations', () => {
  it('accepts an empty list and the hard maximum of valid entries', async () => {
    expect(await errorsFor({ locations: [] })).toEqual([]);
    const max = Array.from({ length: HARD_MAX_SEARCH_LOCATIONS }, (_, i) => `City ${i}`);
    expect(await errorsFor({ locations: max })).toEqual([]);
  });

  it('rejects more than the hard maximum', async () => {
    const tooMany = Array.from({ length: HARD_MAX_SEARCH_LOCATIONS + 1 }, (_, i) => `City ${i}`);
    expect(await errorsFor({ locations: tooMany })).toEqual(['locations']);
  });

  it('rejects a non-string entry and an over-long entry', async () => {
    expect(await errorsFor({ locations: ['Berlin', 42] })).toEqual(['locations']);
    expect(await errorsFor({ locations: ['x'.repeat(MAX_SEARCH_LOCATION_LENGTH + 1)] })).toEqual(['locations']);
    expect(await errorsFor({ locations: 'Berlin' })).toEqual(['locations']);
  });

  it('survives whitelisting', async () => {
    const dto = plainToInstance(ScraperInputDto, { locations: ['A', 'B'] });
    await validate(dto, { whitelist: true });
    expect(dto.locations).toEqual(['A', 'B']);
  });

  it('has no constructor default, so existing cache keys are unchanged', () => {
    const dto = new ScraperInputDto({ searchTerm: 'x' });
    expect('locations' in dto).toBe(false);
    expect('excludeTitleTerms' in dto).toBe(false);
    expect('excludeKeywords' in dto).toBe(false);
    expect('excludePresets' in dto).toBe(false);
  });
});

describe('ScraperInputDto exclusion fields', () => {
  it.each(['excludeTitleTerms', 'excludeKeywords'])('%s accepts valid terms and rejects bad ones', async (field) => {
    expect(await errorsFor({ [field]: ['senior', 'lead*', 'ts/sci'] })).toEqual([]);
    expect(await errorsFor({ [field]: [] })).toEqual([]);
    const tooMany = Array.from({ length: MAX_EXCLUSION_TERMS + 1 }, (_, i) => `t${i}`);
    expect(await errorsFor({ [field]: tooMany })).toEqual([field]);
    expect(await errorsFor({ [field]: ['x'.repeat(MAX_EXCLUSION_TERM_LENGTH + 1)] })).toEqual([field]);
    expect(await errorsFor({ [field]: [7] })).toEqual([field]);
  });

  it('excludePresets accepts known presets only', async () => {
    expect(await errorsFor({ excludePresets: [ExclusionPreset.SECURITY_CLEARANCE] })).toEqual([]);
    expect(await errorsFor({ excludePresets: ['nope'] })).toEqual(['excludePresets']);
  });

  it('all three survive whitelisting', async () => {
    const body = {
      excludeTitleTerms: ['senior'],
      excludeKeywords: ['polygraph'],
      excludePresets: [ExclusionPreset.SECURITY_CLEARANCE],
    };
    const dto = plainToInstance(ScraperInputDto, body);
    await validate(dto, { whitelist: true });
    expect(dto).toMatchObject(body);
  });
});
