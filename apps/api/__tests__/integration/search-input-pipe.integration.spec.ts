/**
 * Spec 1730 review — search input (GraphQL `searchJobs`, REST `POST /api/jobs/search`) through a
 * REAL booted app.
 *
 * The resolver unit tests call `JobsResolver.searchJobs()` directly, so they bypass the global
 * `ValidationPipe`. In production that pipe runs with `whitelist: true`, which strips every
 * input property that carries no class-validator decorator — `@Args` included. Before this fix
 * `SearchJobsInput` had none, so the pipe emptied it: `careerLevels` never reached the resolver
 * (the filter failed OPEN and its 400 never fired) and neither did `searchTerm`, `location`,
 * `siteType`, … (the scrape ran keyword-less).
 *
 * This suite boots Apollo + `JobsResolver` with the production pipe (`createGlobalValidationPipe`,
 * the same factory `main.ts` uses) and the production exception filter, and sends real GraphQL
 * requests over HTTP. Only the fan-out (`JobsService`) and the cache are stubbed; the aggregator
 * and the career-level classifier are real. The REST controller is booted alongside, so the same
 * filter is checked through the same pipe on both surfaces (Q-106: identical in REST and GraphQL).
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Test } from '@nestjs/testing';
import { getMetadataStorage } from 'class-validator';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CareerLevelClassifierService } from '@ever-jobs/career-level-classifier';
import { JobPostDto, Site } from '@ever-jobs/models';

import { CacheService } from '../../src/cache/cache.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { SearchJobsInput } from '../../src/jobs/gql-types';
import { JobsAggregator } from '../../src/jobs/jobs.aggregator';
import { JobsController } from '../../src/jobs/jobs.controller';
import { JobsResolver } from '../../src/jobs/jobs.resolver';
import { JobsService } from '../../src/jobs/jobs.service';
import { createGlobalValidationPipe } from '../../src/pipes/global-validation.pipe';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const fixtureJobs = (): JobPostDto[] => [
  new JobPostDto({ id: '1', title: 'Data Science Intern', jobUrl: 'https://example.com/1' }),
  new JobPostDto({ id: '2', title: 'Principal Engineer', jobUrl: 'https://example.com/2' }),
];

describe('GraphQL searchJobs input through the production ValidationPipe (Spec 1730)', () => {
  let app: INestApplication;
  const jobsService = { searchJobs: jest.fn(), searchJobsWithDiagnostics: jest.fn() };
  const cacheService = { get: jest.fn(), set: jest.fn() };
  const config = { get: (_key: string, def?: unknown) => def };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          sortSchema: true,
        }),
      ],
      controllers: [JobsController],
      providers: [
        JobsResolver,
        { provide: AnalyticsService, useValue: {} },
        { provide: JobsService, useValue: jobsService },
        { provide: CacheService, useValue: cacheService },
        { provide: ConfigService, useValue: config },
        {
          provide: JobsAggregator,
          useFactory: () =>
            new JobsAggregator(
              jobsService as never,
              undefined,
              undefined,
              undefined,
              new CareerLevelClassifierService(),
              config as never,
            ),
        },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jobsService.searchJobs.mockReset().mockImplementation(async () => fixtureJobs());
    jobsService.searchJobsWithDiagnostics
      .mockReset()
      .mockImplementation(async () => ({ jobs: fixtureJobs(), perSource: [] }));
    cacheService.get.mockReset().mockResolvedValue(null);
    cacheService.set.mockReset().mockResolvedValue(undefined);
  });

  const gql = (query: string) =>
    request(app.getHttpServer()).post('/graphql').send({ query }).set('Content-Type', 'application/json');

  it('applies the careerLevels filter (fails closed, not open)', async () => {
    const res = await gql(`{
      searchJobs(input: { searchTerm: "engineer", careerLevels: ["principal"] }) {
        count
        jobs { title careerLevel { level confidence reasons } }
      }
    }`);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.searchJobs.count).toBe(1);
    expect(res.body.data.searchJobs.jobs).toEqual([
      expect.objectContaining({
        title: 'Principal Engineer',
        careerLevel: expect.objectContaining({ level: 'principal' }),
      }),
    ]);
  });

  it('rejects an unknown career level with BAD_REQUEST before scraping', async () => {
    const res = await gql(`{
      searchJobs(input: { searchTerm: "engineer", careerLevels: ["intern"] }) { count }
    }`);

    expect(res.body.data).toBeNull();
    expect(res.body.errors).toHaveLength(1);
    const [error] = res.body.errors;
    expect(error.extensions.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(error)).toMatch(/careerLevels/);
    expect(jobsService.searchJobs).not.toHaveBeenCalled();
  });

  it('delivers every search field to JobsService (none stripped by the whitelist)', async () => {
    const res = await gql(`{
      searchJobs(input: {
        searchTerm: "engineer"
        location: "New York"
        resultsWanted: 7
        country: "USA"
        distance: 25
        companySlug: "acme"
        descriptionFormat: "html"
        siteType: [LINKEDIN]
        dedup: false
      }) { count deduped }
    }`);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.searchJobs).toEqual({ count: 2, deduped: false });
    expect(jobsService.searchJobs).toHaveBeenCalledTimes(1);
    expect(jobsService.searchJobs.mock.calls[0]![0]).toEqual({
      searchTerm: 'engineer',
      location: 'New York',
      resultsWanted: 7,
      country: 'USA',
      distance: 25,
      companySlug: 'acme',
      descriptionFormat: 'html',
      siteType: [Site.LINKEDIN],
    });
  });

  it('gives every SearchJobsInput field a class-validator decorator (whitelist keeps it)', async () => {
    const res = await gql(`{ __type(name: "SearchJobsInput") { inputFields { name } } }`);
    const graphqlFields: string[] = res.body.data.__type.inputFields.map((f: { name: string }) => f.name);
    expect(graphqlFields).toEqual(expect.arrayContaining(['searchTerm', 'careerLevels', 'siteType']));

    const decorated = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(SearchJobsInput, '', true, false)
        .map((m) => m.propertyName),
    );
    expect(graphqlFields.filter((name) => !decorated.has(name))).toEqual([]);
  });

  describe('REST parity: POST /api/jobs/search', () => {
    const search = (body: Record<string, unknown>) =>
      request(app.getHttpServer()).post('/api/jobs/search').send(body).set('Content-Type', 'application/json');

    it('applies the careerLevels filter', async () => {
      const res = await search({ searchTerm: 'engineer', careerLevels: ['principal'] });
      expect(res.status).toBe(201);
      expect(res.body.count).toBe(1);
      expect(res.body.jobs[0].careerLevel.level).toBe('principal');
      expect(jobsService.searchJobsWithDiagnostics.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ searchTerm: 'engineer', careerLevels: ['principal'] }),
      );
    });

    it('rejects an unknown career level with 400 before scraping', async () => {
      const res = await search({ searchTerm: 'engineer', careerLevels: ['intern'] });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/careerLevels/);
      expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
    });
  });
});
