import { Logger } from '@nestjs/common';
import { UpworkAuthDto, UpworkGrantType } from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';

import {
  UPWORK_TOKEN_URL,
  UPWORK_GRAPHQL_URL,
  UPWORK_TOKEN_EXPIRY_SKEW_SECONDS,
  UPWORK_DEFAULT_TIMEOUT_SECONDS,
} from './upwork.constants';

/**
 * Direct Upwork OAuth2 + GraphQL client.
 *
 * ## Why this exists
 *
 * This replaces `@upwork/node-upwork-oauth2`. That SDK's latest release (2.3.0,
 * published 2024-11-27) still pins `request@2.88.2` — a deprecated HTTP stack
 * whose advisories have **no upstream fix** (`request` SSRF GHSA-p8p7-x288-28g6,
 * `tough-cookie` prototype pollution GHSA-72xf-g2v4-qvf3, `uuid` buffer bounds
 * GHSA-w5hq-g745-h8pq). There is no clean version to upgrade to.
 *
 * Forking and republishing it was considered and rejected: the plugin only ever
 * used three things from the SDK — construct a client, obtain a token, POST one
 * GraphQL document. Reimplementing those here **removes** a dependency instead
 * of adopting one, and reuses `createHttpClient` so Upwork inherits the same
 * timeout / retry / proxy handling as every other source.
 *
 * ## Wire compatibility
 *
 * Endpoints and semantics are transcribed from the SDK so behaviour is
 * unchanged:
 *   - `client_credentials` → POST {@link UPWORK_TOKEN_URL} (SDK: `Client.getToken`
 *     → `simple-oauth2` `ClientCredentials.getToken()`).
 *   - `authorization_code` → the caller supplies an access/refresh pair; we
 *     refresh via `grant_type=refresh_token` only when the token is expired
 *     (SDK: `Client.setAccessToken`, which refreshes only on `aToken.expired()`).
 *   - GraphQL → POST {@link UPWORK_GRAPHQL_URL} with `Authorization: Bearer`,
 *     `Content-Type: application/json`, body `{query, variables}` (SDK:
 *     `Client.post` with `entryPoint === 'graphql'`).
 *
 * 🛑 Client credentials are sent in the **request body**, not as an
 * `Authorization: Basic` header — the SDK sets simple-oauth2's
 * `authorizationMethod: 'body'`. Using Basic auth here returns 401.
 */

/** Shape of a successful Upwork token response. */
export interface UpworkTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  /** Lifetime in seconds, as returned by the token endpoint. */
  expires_in?: number;
}

/** A GraphQL request, matching what the SDK's `Graphql.execute` accepted. */
export interface UpworkGraphqlRequest {
  query: string;
  /**
   * Upwork expects `variables` as a JSON **string**, which is what the existing
   * caller already passes. Objects are serialised here so both forms work.
   */
  variables?: string | Record<string, unknown>;
}

/** Thrown for any non-2xx or GraphQL-level failure, so callers see one type. */
export class UpworkApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpworkApiError';
  }
}

/**
 * Obtains and caches an Upwork access token.
 *
 * One instance per credential set. Tokens are cached in memory and reused until
 * they are within {@link UPWORK_TOKEN_EXPIRY_SKEW_SECONDS} of expiry, so a
 * fan-out of searches costs one token request rather than one per search.
 */
export class UpworkTokenProvider {
  private readonly logger = new Logger(UpworkTokenProvider.name);
  private readonly http = createHttpClient({
    timeout: UPWORK_DEFAULT_TIMEOUT_SECONDS,
  });

  private cachedToken?: string;
  /** Epoch ms at which {@link cachedToken} should no longer be used. */
  private cachedExpiresAt = 0;
  private refreshToken?: string;

  constructor(
    private readonly auth: UpworkAuthDto,
    private readonly grantType: UpworkGrantType,
  ) {
    this.refreshToken = auth.refreshToken;
    // An caller-supplied access token is usable immediately. We do not know its
    // expiry, so treat it as valid until Upwork rejects it — the SDK behaved the
    // same way when `expiresAt` was absent.
    if (grantType === UpworkGrantType.AUTHORIZATION_CODE && auth.accessToken) {
      this.cachedToken = auth.accessToken;
      this.cachedExpiresAt = Number.POSITIVE_INFINITY;
    }
  }

  /** `true` once the cached token is missing or within the expiry skew. */
  private get needsToken(): boolean {
    if (!this.cachedToken) return true;
    return Date.now() >= this.cachedExpiresAt;
  }

  /**
   * Return a usable access token, obtaining or refreshing one if required.
   *
   * @param force re-fetch even if a cached token looks valid. Used after a 401,
   *   which is the only reliable signal that a token with unknown expiry died.
   */
  async getAccessToken(force = false): Promise<string> {
    if (!force && !this.needsToken && this.cachedToken) {
      return this.cachedToken;
    }

    const token =
      this.grantType === UpworkGrantType.CLIENT_CREDENTIALS
        ? await this.requestToken({ grant_type: 'client_credentials' })
        : await this.refreshAccessToken();

    this.cachedToken = token.access_token;
    if (token.refresh_token) this.refreshToken = token.refresh_token;
    this.cachedExpiresAt = token.expires_in
      ? Date.now() +
        (token.expires_in - UPWORK_TOKEN_EXPIRY_SKEW_SECONDS) * 1000
      : Number.POSITIVE_INFINITY;

    return this.cachedToken;
  }

  /** Exchange the refresh token for a fresh access token. */
  private async refreshAccessToken(): Promise<UpworkTokenResponse> {
    if (!this.refreshToken) {
      throw new UpworkApiError(
        'Upwork authorization_code grant requires a refreshToken to obtain a new access token',
      );
    }
    return this.requestToken({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });
  }

  /**
   * POST the token endpoint.
   *
   * 🛑 `client_id` / `client_secret` go in the BODY — see
   * `UPWORK_AUTHORIZATION_METHOD`.
   */
  private async requestToken(
    params: Record<string, string>,
  ): Promise<UpworkTokenResponse> {
    const body = new URLSearchParams({
      ...params,
      client_id: this.auth.clientId ?? '',
      client_secret: this.auth.clientSecret ?? '',
    });

    try {
      const res = await this.http.post<UpworkTokenResponse>(
        UPWORK_TOKEN_URL,
        body.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
      const data = res.data;
      if (!data?.access_token) {
        throw new UpworkApiError(
          `Upwork token endpoint returned no access_token (grant_type=${params.grant_type})`,
        );
      }
      return data;
    } catch (err: unknown) {
      if (err instanceof UpworkApiError) throw err;
      // Never echo the response body — a failed token exchange can reflect the
      // submitted client_secret back in the error payload.
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      throw new UpworkApiError(
        `Upwork token request failed (grant_type=${params.grant_type})${
          status ? ` with HTTP ${status}` : ''
        }`,
        status,
      );
    }
  }

  /** Test seam: drop any cached token. */
  reset(): void {
    this.cachedToken = undefined;
    this.cachedExpiresAt = 0;
  }
}

/**
 * Execute one GraphQL document against the Upwork API.
 *
 * Retries exactly once on 401 with a forced token refresh — an access token
 * supplied by the caller has unknown expiry, so a 401 is the only reliable
 * signal that it died. Any other failure surfaces as {@link UpworkApiError}.
 */
export async function executeUpworkGraphql<T = unknown>(
  tokens: UpworkTokenProvider,
  request: UpworkGraphqlRequest,
  logger?: Logger,
): Promise<T> {
  const http = createHttpClient({ timeout: UPWORK_DEFAULT_TIMEOUT_SECONDS });

  const body = {
    query: request.query,
    variables:
      typeof request.variables === 'string'
        ? request.variables
        : JSON.stringify(request.variables ?? {}),
  };

  const send = async (token: string) =>
    http.post<{ data?: T; errors?: { message?: string }[] }>(
      UPWORK_GRAPHQL_URL,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

  let res;
  try {
    res = await send(await tokens.getAccessToken());
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status !== 401) {
      throw new UpworkApiError(
        `Upwork GraphQL request failed${status ? ` with HTTP ${status}` : ''}`,
        status,
      );
    }
    logger?.warn('Upwork access token rejected (401) — refreshing and retrying');
    res = await send(await tokens.getAccessToken(true));
  }

  const payload = res.data;

  // GraphQL reports failures in-band with HTTP 200, so this check is required
  // and is NOT redundant with the status handling above.
  if (payload?.errors?.length) {
    const first = payload.errors[0]?.message ?? 'unknown GraphQL error';
    throw new UpworkApiError(
      `Upwork GraphQL error: ${first}${
        payload.errors.length > 1 ? ` (+${payload.errors.length - 1} more)` : ''
      }`,
    );
  }

  return payload?.data as T;
}
