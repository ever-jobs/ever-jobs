/**
 * Types for the Wellfound company-board scraper.
 *
 * Shape verified against an archived live board
 * (`wellfound.com/company/0xbuildspace/jobs`): the SSR'd `#__NEXT_DATA__`
 * JSON holds `props.pageProps.apolloState.data`, a normalized Apollo cache
 * keyed `"<TypeName>:<id>"`. Job postings are `JobListing` nodes; fields are
 * primitives or `{__ref}` pointers into the same cache.
 */

export interface WellfoundAtsNextData {
  props?: {
    pageProps?: {
      apolloState?: {
        data?: Record<string, WellfoundAtsCacheEntry>;
      };
    };
  };
}

export interface WellfoundAtsCacheEntry {
  __typename?: string;
  id?: string;
  [key: string]: unknown;
}

/** `JobListing` node fields observed in the Apollo cache. */
export interface WellfoundAtsJobListing {
  __typename: 'JobListing';
  id: string;
  title?: string;
  slug?: string;
  /** Role taxonomy — parent is the broader grouping, used as `department`. */
  primaryRoleParent?: string;
  primaryRoleTitle?: string;
  /** Posting timestamp, epoch *seconds*. */
  liveStartAt?: number;
  /** HTML snippet of the posting body (the full body lives on the detail page). */
  descriptionSnippet?: string;
  jobType?: string;
  locationNames?: string[];
  remote?: boolean;
  remoteConfig?: { __ref?: string } | null;
  /** Pre-formatted range, e.g. `"$120k – $200k"`. */
  compensation?: string | null;
  estimatedSalary?: unknown;
  equity?: unknown;
  startup?: { __ref?: string };
  [key: string]: unknown;
}

export interface WellfoundAtsRemoteConfig {
  __typename: 'JobListingRemoteConfig';
  id?: string;
  kind?: string;
}

export interface WellfoundAtsStartup {
  __typename: 'Startup';
  id?: string;
  slug?: string;
  name?: string;
  [key: string]: unknown;
}
