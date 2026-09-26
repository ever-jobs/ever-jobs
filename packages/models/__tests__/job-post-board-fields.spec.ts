import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JobPostDto, ScraperInputDto } from '../src';

/**
 * Specs 1693 / 1701 — fields the board plugins already set are declared on
 * the shared DTOs, so the API's `ValidationPipe({ whitelist: true })` keeps
 * `linkedinFetchCompanyDetails` instead of silently stripping it.
 */
async function validated(body: Record<string, unknown>): Promise<{ dto: ScraperInputDto; errors: string[] }> {
  const dto = plainToInstance(ScraperInputDto, body);
  const errors = await validate(dto, { whitelist: true });
  return { dto, errors: errors.map((e) => e.property) };
}

describe('ScraperInputDto.linkedinFetchCompanyDetails (Spec 1701)', () => {
  it('survives whitelist validation as a boolean', async () => {
    const { dto, errors } = await validated({ linkedinFetchCompanyDetails: true });
    expect(errors).toEqual([]);
    expect(dto.linkedinFetchCompanyDetails).toBe(true);
  });

  it('rejects a non-boolean value', async () => {
    const { errors } = await validated({ linkedinFetchCompanyDetails: 'yes' });
    expect(errors).toEqual(['linkedinFetchCompanyDetails']);
  });

  it('stays unset by default so the env var decides', () => {
    expect(new ScraperInputDto().linkedinFetchCompanyDetails).toBeUndefined();
    expect(new ScraperInputDto({ searchTerm: 'x' }).linkedinFetchCompanyDetails).toBeUndefined();
  });
});

describe('JobPostDto board fields (Specs 1693 / 1701)', () => {
  it('carries the applicant, company-id and AI-level fields through the constructor', () => {
    const job = new JobPostDto({
      id: 'li-1',
      title: 'Engineer',
      companyName: 'Acme',
      jobUrl: 'https://example.com/1',
      companySourceId: '12345',
      applicantsCount: 200,
      applicantsCountBound: 'min',
      aiLevel: 3,
    });
    expect(job).toMatchObject({
      companySourceId: '12345',
      applicantsCount: 200,
      applicantsCountBound: 'min',
      aiLevel: 3,
    });
  });
});
