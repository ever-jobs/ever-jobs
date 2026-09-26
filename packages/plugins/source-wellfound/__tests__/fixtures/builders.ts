/**
 * Synthetic Wellfound payload builders for the Spec 1708 suites. Key names,
 * casing, the connection-key format and the inline `remoteConfig` follow the
 * live landing pages; every company, id and text is invented.
 */
import * as fs from 'fs';
import * as path from 'path';

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

export function loadJsonFixture<T = Record<string, any>>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}

/** A landing page: optional CDN beacon in the head, the payload at the end of the body. */
export function htmlPage(nd: unknown, options: { beacon?: boolean } = {}): string {
  const beacon = options.beacon ? readFixture('cdn-beacon.snippet.html') : '';
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Jobs</title>${beacon}</head>` +
    `<body><div id="__next"></div>` +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script></body></html>`
  );
}

export interface SyntheticStartup {
  id: string;
  name?: string;
  /** Listing ids, in the order the company highlights them. */
  listings: string[];
}

export interface LandingOptions {
  page?: number;
  pageCount?: number;
  role?: string;
  location?: string;
  remote?: boolean;
  startups: SyntheticStartup[];
  /** Slug of the page's `SeoRoleKeyword`; `null` leaves the node out. Defaults to `role`. */
  roleKeyword?: string | null;
  /** Per-listing field overrides. */
  listings?: Record<string, Record<string, unknown>>;
}

export function syntheticListing(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'JobListingSearchResult',
    id,
    title: `Software Engineer ${id}`,
    slug: `software-engineer-${id}`,
    description: `Build things at company ${id}.`,
    jobType: 'full-time',
    liveStartAt: 1790000000,
    locationNames: ['San Francisco'],
    acceptedRemoteLocationNames: [],
    remote: false,
    remoteConfig: null,
    primaryRoleTitle: 'Software Engineer',
    compensation: '$100k – $120k',
    yearsExperienceMin: null,
    yearsExperienceMax: null,
    atsSource: null,
    autoPosted: false,
    isBookmarked: false,
    ...overrides,
  };
}

/** A `__NEXT_DATA__` document shaped like a role/location landing page. */
export function landingPayload(options: LandingOptions): Record<string, unknown> {
  const page = options.page ?? 1;
  const role = options.role ?? 'software-engineer';
  const args: Record<string, unknown> = {};
  if (options.location) args.location = options.location;
  args.page = page;
  if (options.remote) args.remote = true;
  args.role = role;

  const data: Record<string, unknown> = {
    ROOT_QUERY: {
      __typename: 'Query',
      talent: {
        __typename: 'Talent',
        [`seoLandingPageJobSearchResults(${JSON.stringify(args)})`]: {
          __typename: 'Results',
          totalStartupCount: options.startups.length,
          totalJobCount: options.startups.reduce((n, s) => n + s.listings.length, 0),
          perPage: 20,
          pageCount: options.pageCount ?? 1,
          startups: options.startups.map((s) => ({ __ref: `StartupResult:${s.id}` })),
        },
      },
    },
  };
  for (const startup of options.startups) {
    data[`StartupResult:${startup.id}`] = {
      __typename: 'StartupResult',
      id: startup.id,
      name: startup.name ?? `Company ${startup.id}`,
      slug: `company-${startup.id}`,
      logoUrl: null,
      highConcept: `Tagline ${startup.id}`,
      companySize: 'SIZE_11_50',
      badges: [],
      highlightedJobListings: startup.listings.map((id) => ({ __ref: `JobListingSearchResult:${id}` })),
    };
    for (const id of startup.listings) {
      data[`JobListingSearchResult:${id}`] = syntheticListing(id, options.listings?.[id]);
    }
  }
  const keyword = options.roleKeyword === undefined ? role : options.roleKeyword;
  if (keyword !== null) {
    data['SeoRoleKeyword:1'] = { __typename: 'SeoRoleKeyword', id: '1', slug: keyword, displayName: keyword };
  }

  const query: Record<string, unknown> = { role };
  if (options.location) query.location = options.location;
  if (page > 1) query.page = String(page);
  return {
    page: options.location ? '/seoLanding/roleLocationSearch' : '/seoLanding/roleSearch',
    query,
    buildId: 'synthetic-build',
    props: { pageProps: { role, apolloState: { data } } },
  };
}
