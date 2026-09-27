import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  JOB_LIVENESS_REASON_FRESH_FETCH,
  JOB_LIVENESS_REASON_LISTED,
  JobLivenessReason,
  JobPostDto,
  ScraperInputDto,
} from '../src';

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

describe('JobPostDto.jobUrlFetchedAt and liveness.reason (Spec 1714 FR-16)', () => {
  it('are optional and unset by default', () => {
    const job = new JobPostDto({ title: 't', jobUrl: 'https://acme.softy.pro/offers/1' });
    expect(job.jobUrlFetchedAt).toBeUndefined();
    expect(job.liveness).toBeUndefined();
  });

  it('carry the fresh-fetch signal and the reason a job was marked live without a probe', () => {
    const fetchedAt = '2026-09-26T10:00:00.000Z';
    const job = new JobPostDto({
      title: 't',
      jobUrl: 'https://acme.softy.pro/offers/1',
      jobUrlFetchedAt: fetchedAt,
      liveness: { state: 'active', checkedAt: fetchedAt, reason: JOB_LIVENESS_REASON_FRESH_FETCH },
    });
    expect(job.jobUrlFetchedAt).toBe(fetchedAt);
    expect(job.liveness).toEqual({ state: 'active', checkedAt: fetchedAt, reason: 'fresh-fetch' });
  });

  it('JOB_LIVENESS_REASON_FRESH_FETCH is the documented wire value', () => {
    expect(JOB_LIVENESS_REASON_FRESH_FETCH).toBe('fresh-fetch');
  });
});

describe('JobPostDto.jobUrlListedAt and the "listed" liveness reason (Spec 1715, audit A3)', () => {
  it('is optional and unset by default', () => {
    const job = new JobPostDto({ title: 't', jobUrl: 'https://acme.softy.pro/offers/1' });
    expect(job.jobUrlListedAt).toBeUndefined();
    expect(Object.keys(job)).not.toContain('jobUrlListedAt');
  });

  it('carries the sitemap fetch time, apart from jobUrlFetchedAt', () => {
    const listedAt = '2026-09-27T09:55:00.000Z';
    const job = new JobPostDto({
      title: 't',
      jobUrl: 'https://acme.softy.pro/offers/1',
      jobUrlListedAt: listedAt,
      liveness: { state: 'active', checkedAt: listedAt, reason: JOB_LIVENESS_REASON_LISTED },
    });
    expect(job.jobUrlListedAt).toBe(listedAt);
    expect(job.jobUrlFetchedAt).toBeUndefined();
    expect(job.liveness).toEqual({ state: 'active', checkedAt: listedAt, reason: 'listed' });
  });

  it('JOB_LIVENESS_REASON_LISTED is the documented wire value, distinct from fresh-fetch', () => {
    expect(JOB_LIVENESS_REASON_LISTED).toBe('listed');
    const reasons: JobLivenessReason[] = [JOB_LIVENESS_REASON_FRESH_FETCH, JOB_LIVENESS_REASON_LISTED];
    expect(new Set(reasons).size).toBe(2);
  });

  it('survives a JSON round trip (the wire shape)', () => {
    const job = new JobPostDto({ title: 't', jobUrl: 'https://x/1', jobUrlListedAt: '2026-09-27T09:55:00.000Z' });
    expect(JSON.parse(JSON.stringify(job)).jobUrlListedAt).toBe('2026-09-27T09:55:00.000Z');
  });
});
