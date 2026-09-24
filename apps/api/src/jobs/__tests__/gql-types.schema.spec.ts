import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { GraphQLObjectType, GraphQLSchema, graphql, printType } from 'graphql';
import { JobPostDto, LocationDto, OfficeDto, Site } from '@ever-jobs/models';
import { JobsResolver } from '../jobs.resolver';
import { SearchJobsInput } from '../gql-types';

/**
 * Spec 1689 — the GraphQL surface carries the fork's additive fields
 * (Specs 5118/5123): `JobPost.countryCode`, `JobPost.locations[]`,
 * `JobPost.offices[]`, and `Location.name/text/streetAddress/postalCode`.
 *
 * The resolver returns `JobPostDto`s as-is (no hand-copied mapping), so the
 * types alone decide what a client can select. This builds the real
 * code-first schema and executes a query against it.
 */
describe('GraphQL schema — additive location fields (Spec 1689)', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    await moduleRef.init();
    const factory = moduleRef.get(GraphQLSchemaFactory);
    schema = await factory.create([JobsResolver]);
  });

  function fieldsOf(typeName: string): Record<string, string> {
    const type = schema.getType(typeName) as GraphQLObjectType;
    expect(type).toBeDefined();
    return Object.fromEntries(
      Object.values(type.getFields()).map((f) => [f.name, String(f.type)]),
    );
  }

  it('exposes countryCode, locations[] and offices[] on JobPostGql, all nullable', () => {
    const fields = fieldsOf('JobPostGql');
    expect(fields.countryCode).toBe('String');
    expect(fields.locations).toBe('[LocationGql!]');
    expect(fields.offices).toBe('[OfficeGql!]');
  });

  it('keeps every pre-existing JobPostGql field', () => {
    const fields = fieldsOf('JobPostGql');
    for (const name of [
      'id', 'site', 'title', 'companyName', 'jobUrl', 'location', 'description',
      'jobType', 'compensation', 'datePosted', 'emails', 'isRemote', 'companyUrl', 'logoUrl',
    ]) {
      expect(fields).toHaveProperty(name);
    }
  });

  it('exposes name/text/streetAddress/postalCode on LocationGql, all nullable', () => {
    const fields = fieldsOf('LocationGql');
    expect(fields).toEqual({
      country: 'String',
      city: 'String',
      state: 'String',
      name: 'String',
      text: 'String',
      streetAddress: 'String',
      postalCode: 'String',
    });
  });

  it('OfficeGql carries the location fields plus id', () => {
    const fields = fieldsOf('OfficeGql');
    expect(fields.id).toBe('String');
    expect(fields.city).toBe('String');
    expect(fields.postalCode).toBe('String');
    expect(printType(schema.getType('OfficeGql')!)).toContain('type OfficeGql');
  });

  it('resolves the new fields straight off a JobPostDto', async () => {
    const job = new JobPostDto({
      id: 'lever-1',
      site: Site.LEVER,
      title: 'Operator',
      companyName: 'acme',
      jobUrl: 'https://jobs.lever.co/acme/1',
      countryCode: 'NL',
      location: new LocationDto({
        city: 'Amsterdam',
        country: 'Netherlands',
        text: 'Amsterdam (HQ)',
        name: 'HQ',
        streetAddress: 'Damrak 1',
        postalCode: '1012 LG',
      }),
      locations: [
        new LocationDto({ city: 'Amsterdam', country: 'Netherlands' }),
        new LocationDto({ city: 'Austin', state: 'TX' }),
      ],
      offices: [new OfficeDto({ id: '42', name: 'Emeryville', city: 'Emeryville', state: 'CA' })],
    });
    const legacy = new JobPostDto({
      id: 'legacy-1',
      site: Site.LINKEDIN,
      title: 'Engineer',
      companyName: 'Acme',
      jobUrl: 'https://example.com/1',
      location: new LocationDto({ city: 'Berlin' }),
    });

    const queryType = schema.getQueryType()!;
    queryType.getFields().searchJobs.resolve = () => ({
      count: 2,
      jobs: [job, legacy],
      cached: false,
      deduped: false,
      rawCount: 2,
    });

    const result = await graphql({
      schema,
      source: `{
        searchJobs(input: { searchTerm: "x" }) {
          jobs {
            id countryCode
            location { city state country name text streetAddress postalCode }
            locations { city state country }
            offices { id name city state }
          }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const [first, second] = (result.data as any).searchJobs.jobs;
    expect(first).toEqual({
      id: 'lever-1',
      countryCode: 'NL',
      location: {
        city: 'Amsterdam',
        state: null,
        country: 'Netherlands',
        name: 'HQ',
        text: 'Amsterdam (HQ)',
        streetAddress: 'Damrak 1',
        postalCode: '1012 LG',
      },
      locations: [
        { city: 'Amsterdam', state: null, country: 'Netherlands' },
        { city: 'Austin', state: 'TX', country: null },
      ],
      offices: [{ id: '42', name: 'Emeryville', city: 'Emeryville', state: 'CA' }],
    });
    // A job without the new data resolves them as null — no breaking change.
    expect(second).toMatchObject({
      id: 'legacy-1',
      countryCode: null,
      locations: null,
      offices: null,
      location: { city: 'Berlin', name: null, text: null },
    });
  });
});

/**
 * Spec 1689 — the global `ValidationPipe({ whitelist: true })` (apps/api/src/main.ts)
 * also runs on resolver `@Args`. Before SearchJobsInput carried class-validator
 * decorators, whitelisting stripped every field and the resolver received `{}`.
 */
describe('SearchJobsInput under the global ValidationPipe (Spec 1689)', () => {
  // Same options as apps/api/src/main.ts.
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
  const meta = { type: 'body' as const, metatype: SearchJobsInput, data: 'input' };

  it('keeps every declared field instead of stripping the input to {}', async () => {
    const input = {
      siteType: [Site.LEVER, Site.WORKDAY],
      searchTerm: 'rust engineer',
      location: 'Berlin',
      resultsWanted: 5,
      country: 'DE',
      distance: 25,
      companySlug: 'acme',
      descriptionFormat: 'text',
      dedup: false,
    };
    const out = await pipe.transform({ ...input }, meta);
    expect(out).toBeInstanceOf(SearchJobsInput);
    expect({ ...out }).toEqual(input);
  });

  it('accepts a minimal input and explicit nulls on nullable fields', async () => {
    const out = await pipe.transform({ searchTerm: 'x', location: null, siteType: null }, meta);
    expect(out.searchTerm).toBe('x');
  });

  it('still strips undeclared keys', async () => {
    const out = await pipe.transform({ searchTerm: 'x', bogus: 1 }, meta);
    expect(out).not.toHaveProperty('bogus');
  });
});
