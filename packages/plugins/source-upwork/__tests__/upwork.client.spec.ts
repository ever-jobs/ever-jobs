import { UpworkAuthDto, UpworkGrantType } from '@ever-jobs/models';

import {
  UpworkTokenProvider,
  executeUpworkGraphql,
  UpworkApiError,
} from '../src/upwork.client';
import {
  UPWORK_TOKEN_URL,
  UPWORK_GRAPHQL_URL,
} from '../src/upwork.constants';

/**
 * Wire contract for the direct Upwork client that replaced
 * `@upwork/node-upwork-oauth2`.
 *
 * These assertions are transcribed from the SDK's own source (2.3.0) rather
 * than from documentation, because an SDK replacement fails in exactly one
 * way: it *looks* right and returns 401 in production. The load-bearing facts:
 *
 *   - credentials go in the request BODY (`authorizationMethod: 'body'`),
 *     NOT an `Authorization: Basic` header;
 *   - the token endpoint is www.upwork.com, the GraphQL endpoint is
 *     api.upwork.com — two different hosts;
 *   - GraphQL `variables` is sent as a JSON STRING;
 *   - GraphQL reports failures in-band with HTTP 200.
 */

// Capture every outbound call without performing one.
const posts: { url: string; body: any; config: any }[] = [];
let nextResponse: (url: string) => any;

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: () => ({
      post: jest.fn(async (url: string, body: any, config: any) => {
        posts.push({ url, body, config });
        return nextResponse(url);
      }),
    }),
  };
});

const clientCreds = () =>
  new UpworkAuthDto({ clientId: 'cid-123', clientSecret: 'secret-xyz' });

beforeEach(() => {
  posts.length = 0;
  nextResponse = (url) =>
    url === UPWORK_TOKEN_URL
      ? { data: { access_token: 'tok-1', expires_in: 3600 } }
      : { data: { data: { marketplaceJobPostings: { edges: [] } } } };
});

describe('UpworkTokenProvider — client_credentials', () => {
  it('posts to the token endpoint with credentials in the BODY, not a Basic header', async () => {
    const tokens = new UpworkTokenProvider(
      clientCreds(),
      UpworkGrantType.CLIENT_CREDENTIALS,
    );
    await tokens.getAccessToken();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(UPWORK_TOKEN_URL);

    const body = new URLSearchParams(posts[0].body as string);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('cid-123');
    expect(body.get('client_secret')).toBe('secret-xyz');
    expect(posts[0].config.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );

    // 🛑 The regression this guards: Basic auth here returns 401 from Upwork.
    expect(posts[0].config.headers.Authorization).toBeUndefined();
  });

  it('caches the token so a fan-out costs one token request', async () => {
    const tokens = new UpworkTokenProvider(
      clientCreds(),
      UpworkGrantType.CLIENT_CREDENTIALS,
    );
    await tokens.getAccessToken();
    await tokens.getAccessToken();
    await tokens.getAccessToken();

    expect(posts.filter((p) => p.url === UPWORK_TOKEN_URL)).toHaveLength(1);
  });

  it('never leaks the client secret into the error message', async () => {
    nextResponse = () => {
      throw Object.assign(new Error('boom'), {
        response: { status: 400, data: { client_secret: 'secret-xyz' } },
      });
    };
    const tokens = new UpworkTokenProvider(
      clientCreds(),
      UpworkGrantType.CLIENT_CREDENTIALS,
    );

    await expect(tokens.getAccessToken()).rejects.toThrow(UpworkApiError);
    await expect(tokens.getAccessToken()).rejects.not.toThrow(
      /secret-xyz/,
    );
  });
});

describe('UpworkTokenProvider — authorization_code', () => {
  it('uses a caller-supplied access token without contacting the token endpoint', async () => {
    const tokens = new UpworkTokenProvider(
      new UpworkAuthDto({
        clientId: 'cid',
        clientSecret: 'sec',
        accessToken: 'caller-token',
        refreshToken: 'refresh-token',
      }),
      UpworkGrantType.AUTHORIZATION_CODE,
    );

    expect(await tokens.getAccessToken()).toBe('caller-token');
    expect(posts).toHaveLength(0);
  });

  it('refreshes with grant_type=refresh_token when forced', async () => {
    nextResponse = () => ({
      data: { access_token: 'tok-2', refresh_token: 'refresh-2', expires_in: 60 },
    });
    const tokens = new UpworkTokenProvider(
      new UpworkAuthDto({
        clientId: 'cid',
        clientSecret: 'sec',
        accessToken: 'stale',
        refreshToken: 'refresh-1',
      }),
      UpworkGrantType.AUTHORIZATION_CODE,
    );

    expect(await tokens.getAccessToken(true)).toBe('tok-2');
    const body = new URLSearchParams(posts[0].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('fails clearly when a refresh is needed but no refresh token exists', async () => {
    const tokens = new UpworkTokenProvider(
      new UpworkAuthDto({ clientId: 'cid', clientSecret: 'sec' }),
      UpworkGrantType.AUTHORIZATION_CODE,
    );
    await expect(tokens.getAccessToken()).rejects.toThrow(/refreshToken/);
  });
});

describe('executeUpworkGraphql', () => {
  const tokens = () =>
    new UpworkTokenProvider(clientCreds(), UpworkGrantType.CLIENT_CREDENTIALS);

  it('posts to the GraphQL host with a Bearer token and JSON-string variables', async () => {
    await executeUpworkGraphql(tokens(), {
      query: 'query {}',
      variables: { first: 5 },
    });

    const gql = posts.find((p) => p.url === UPWORK_GRAPHQL_URL);
    expect(gql).toBeDefined();
    // Two DIFFERENT hosts — token on www, GraphQL on api.
    expect(UPWORK_GRAPHQL_URL).not.toContain('www.upwork.com');
    expect(gql!.config.headers.Authorization).toBe('Bearer tok-1');
    expect(gql!.config.headers['Content-Type']).toBe('application/json');
    // Upwork requires `variables` as a STRING, not a nested object.
    expect(typeof gql!.body.variables).toBe('string');
    expect(JSON.parse(gql!.body.variables)).toEqual({ first: 5 });
  });

  it('passes an already-stringified variables payload through untouched', async () => {
    await executeUpworkGraphql(tokens(), {
      query: 'query {}',
      variables: '{"first":7}',
    });
    const gql = posts.find((p) => p.url === UPWORK_GRAPHQL_URL);
    expect(gql!.body.variables).toBe('{"first":7}');
  });

  it('unwraps the GraphQL data envelope', async () => {
    nextResponse = (url) =>
      url === UPWORK_TOKEN_URL
        ? { data: { access_token: 'tok-1', expires_in: 3600 } }
        : { data: { data: { marketplaceJobPostings: { edges: [{ node: { id: 'a' } }] } } } };

    const data = await executeUpworkGraphql<any>(tokens(), { query: 'q' });
    expect(data.marketplaceJobPostings.edges).toHaveLength(1);
  });

  it('throws on in-band GraphQL errors even though HTTP is 200', async () => {
    // 🛑 The check that a status-code-only implementation would miss.
    nextResponse = (url) =>
      url === UPWORK_TOKEN_URL
        ? { data: { access_token: 'tok-1', expires_in: 3600 } }
        : { data: { errors: [{ message: 'field X not found' }] } };

    await expect(
      executeUpworkGraphql(tokens(), { query: 'q' }),
    ).rejects.toThrow(/field X not found/);
  });

  it('refreshes once and retries on 401, then succeeds', async () => {
    let gqlCalls = 0;
    nextResponse = (url) => {
      if (url === UPWORK_TOKEN_URL) {
        return { data: { access_token: `tok-${posts.filter((p) => p.url === UPWORK_TOKEN_URL).length}`, expires_in: 3600 } };
      }
      gqlCalls += 1;
      if (gqlCalls === 1) {
        throw Object.assign(new Error('unauthorized'), {
          response: { status: 401 },
        });
      }
      return { data: { data: { ok: true } } };
    };

    const data = await executeUpworkGraphql<any>(tokens(), { query: 'q' });
    expect(data).toEqual({ ok: true });
    expect(gqlCalls).toBe(2);
    // Exactly two token requests: the initial one and the forced refresh.
    expect(posts.filter((p) => p.url === UPWORK_TOKEN_URL)).toHaveLength(2);
  });

  it('does not retry non-401 failures', async () => {
    let gqlCalls = 0;
    nextResponse = (url) => {
      if (url === UPWORK_TOKEN_URL) {
        return { data: { access_token: 'tok-1', expires_in: 3600 } };
      }
      gqlCalls += 1;
      throw Object.assign(new Error('server error'), {
        response: { status: 500 },
      });
    };

    await expect(
      executeUpworkGraphql(tokens(), { query: 'q' }),
    ).rejects.toThrow(UpworkApiError);
    expect(gqlCalls).toBe(1);
  });
});
