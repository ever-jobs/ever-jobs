import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CAREER_LEVELS, isCareerLevel, JobPostDto, ScraperInputDto } from '../src';

/** Spec 1730 — the career-level contract and the `careerLevels` request filter validation. */
describe('career-level contract (Spec 1730)', () => {
  const errorsFor = async (body: Record<string, unknown>): Promise<string[]> => {
    const dto = plainToInstance(ScraperInputDto, body);
    const errors = await validate(dto);
    return errors.map((e) => e.property);
  };

  it('lists eleven levels, ending with unknown', () => {
    expect(CAREER_LEVELS).toHaveLength(11);
    expect(CAREER_LEVELS[CAREER_LEVELS.length - 1]).toBe('unknown');
  });

  it('isCareerLevel accepts only the listed levels', () => {
    expect(isCareerLevel('new_grad')).toBe(true);
    expect(isCareerLevel('New_Grad')).toBe(false);
    expect(isCareerLevel('junior')).toBe(false);
    expect(isCareerLevel(undefined)).toBe(false);
    expect(isCareerLevel(3)).toBe(false);
  });

  it('careerLevels is optional', async () => {
    expect(await errorsFor({ searchTerm: 'engineer' })).not.toContain('careerLevels');
  });

  it('accepts known levels, including an empty list', async () => {
    expect(await errorsFor({ careerLevels: ['internship', 'new_grad'] })).not.toContain('careerLevels');
    expect(await errorsFor({ careerLevels: [] })).not.toContain('careerLevels');
  });

  it('rejects an unknown level (→ 400 through the global ValidationPipe)', async () => {
    expect(await errorsFor({ careerLevels: ['internship', 'junior'] })).toContain('careerLevels');
    expect(await errorsFor({ careerLevels: 'internship' })).toContain('careerLevels');
  });

  it('JobPostDto carries careerLevel as an optional field', () => {
    const job = new JobPostDto({
      title: 'Engineer',
      jobUrl: 'https://example.com/1',
      careerLevel: { level: 'mid', confidence: 'medium', reasons: ['title level numeral "engineer ii"'] },
    });
    expect(job.careerLevel?.level).toBe('mid');
    expect(new JobPostDto({ title: 'x', jobUrl: 'y' }).careerLevel).toBeUndefined();
  });
});
