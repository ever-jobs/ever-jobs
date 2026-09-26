import * as fs from 'fs';
import * as path from 'path';
import {
  WTTJ_ALGOLIA_API_KEY,
  WTTJ_ALGOLIA_APP_ID,
  WTTJ_ALGOLIA_JOBS_INDEX_PREFIX,
  WTTJ_CREDENTIAL_REFRESH_COOLDOWN_MS,
  WTTJ_DEFAULT_CREDENTIALS_SEED_URL,
  WTTJ_ENV,
} from '../src/wttj.constants';
import {
  allowedWttjSeedUrl,
  currentWttjCredentials,
  extractWttjCredentials,
  isWttjCredentialRejection,
  maskWttjKey,
  refreshWttjCredentials,
  rememberWttjDetailUrl,
  resetWttjCredentialCache,
  sameWttjCredentials,
  wttjCredentialHeaders,
  wttjCredentialSeedUrls,
} from '../src/wttj.credentials';

const DETAIL_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wttj-detail-runtime-config.html'),
  'utf8',
);
const FRESH_KEY = '0123456789abcdef0123456789abcdef';
const DETAIL_URL =
  'https://www.welcometothejungle.com/fr/companies/acme-robotics/jobs/robotics-software-engineer_paris_ACME_Ab12Cd3';

/**
 * Spec 1705 work item C — credential cache, refusal detection and the single-flight,
 * rate-limited refresh.
 */
describe('WTTJ search credentials (Spec 1705 C)', () => {
  beforeEach(() => {
    resetWttjCredentialCache();
    delete process.env[WTTJ_ENV.CREDENTIALS_SEED_URL];
  });

  afterAll(() => {
    resetWttjCredentialCache();
    delete process.env[WTTJ_ENV.CREDENTIALS_SEED_URL];
  });

  it('starts from the built-in constants', () => {
    expect(currentWttjCredentials()).toEqual({
      appId: WTTJ_ALGOLIA_APP_ID,
      apiKey: WTTJ_ALGOLIA_API_KEY,
      indexPrefix: WTTJ_ALGOLIA_JOBS_INDEX_PREFIX,
      fetchedAt: 0,
    });
    expect(wttjCredentialHeaders(currentWttjCredentials())).toEqual({
      'x-algolia-application-id': WTTJ_ALGOLIA_APP_ID,
      'x-algolia-api-key': WTTJ_ALGOLIA_API_KEY,
    });
  });

  it('reads the runtime config from a detail page', () => {
    expect(extractWttjCredentials(DETAIL_HTML)).toEqual({
      appId: 'TESTAPP123',
      apiKey: FRESH_KEY,
      indexPrefix: 'wttj_jobs_production',
    });
  });

  it('needs both the app id and the key; the prefix is optional', () => {
    expect(extractWttjCredentials('<html>"ALGOLIA_APPLICATION_ID":"TESTAPP123"</html>')).toBeNull();
    expect(extractWttjCredentials(`"ALGOLIA_API_KEY_CLIENT":"${FRESH_KEY}"`)).toBeNull();
    expect(
      extractWttjCredentials(`"ALGOLIA_APPLICATION_ID":"TESTAPP123","ALGOLIA_API_KEY_CLIENT":"${FRESH_KEY}"`),
    ).toEqual({ appId: 'TESTAPP123', apiKey: FRESH_KEY, indexPrefix: null });
    expect(extractWttjCredentials('')).toBeNull();
    expect(extractWttjCredentials(null)).toBeNull();
  });

  it('rejects malformed runtime values', () => {
    expect(
      extractWttjCredentials(`"ALGOLIA_APPLICATION_ID":"bad id","ALGOLIA_API_KEY_CLIENT":"${FRESH_KEY}"`),
    ).toBeNull();
    expect(
      extractWttjCredentials('"ALGOLIA_APPLICATION_ID":"TESTAPP123","ALGOLIA_API_KEY_CLIENT":"XYZ"'),
    ).toBeNull();
  });

  it.each([
    [401, undefined, true],
    [403, 'anything', true],
    [400, 'Invalid Application-ID or API key', true],
    [400, 'Method not allowed with this referer', true],
    [400, 'index does not exist', false],
    [404, 'Invalid Application-ID or API key', false],
    [500, undefined, false],
    [undefined, 'Invalid Application-ID or API key', true],
    [undefined, 'you can only fetch the 1000 hits for this query', false],
    [undefined, undefined, false],
  ])('status %p with message %p is a refusal: %p', (status, message, expected) => {
    expect(isWttjCredentialRejection(status, message)).toBe(expected);
  });

  it('masks all but the first 6 characters of a key', () => {
    expect(maskWttjKey(FRESH_KEY)).toBe('012345...');
  });

  describe('seed URLs', () => {
    it('allows only https detail paths on the site, with no query string', () => {
      expect(allowedWttjSeedUrl(DETAIL_URL)).toBe(DETAIL_URL);
      expect(allowedWttjSeedUrl(`${DETAIL_URL}?q=1`)).toBeNull();
      expect(allowedWttjSeedUrl(`${DETAIL_URL}#apply`)).toBeNull();
      expect(allowedWttjSeedUrl(DETAIL_URL.replace('https:', 'http:'))).toBeNull();
      expect(allowedWttjSeedUrl('https://evil.example.test/en/companies/x/jobs/y')).toBeNull();
      expect(allowedWttjSeedUrl('https://welcometothejungle.com.evil.test/en/jobs/y')).toBeNull();
      expect(allowedWttjSeedUrl('https://user:pw@www.welcometothejungle.com/en/x')).toBeNull();
      expect(allowedWttjSeedUrl('https://www.welcometothejungle.com/')).toBeNull();
      expect(allowedWttjSeedUrl(undefined)).toBeNull();
    });

    it('orders the remembered detail URL, then the env seed, then the built-in seed', () => {
      expect(wttjCredentialSeedUrls({})).toEqual([WTTJ_DEFAULT_CREDENTIALS_SEED_URL]);
      rememberWttjDetailUrl(DETAIL_URL);
      const envSeed = 'https://www.welcometothejungle.com/en/companies/acme-robotics/jobs';
      expect(wttjCredentialSeedUrls({ [WTTJ_ENV.CREDENTIALS_SEED_URL]: envSeed })).toEqual([
        DETAIL_URL,
        envSeed,
        WTTJ_DEFAULT_CREDENTIALS_SEED_URL,
      ]);
    });

    it('drops an unsafe env seed and ignores an unsafe remembered URL', () => {
      rememberWttjDetailUrl('https://evil.example.test/x');
      expect(
        wttjCredentialSeedUrls({ [WTTJ_ENV.CREDENTIALS_SEED_URL]: 'https://www.welcometothejungle.com/en/jobs?query=x' }),
      ).toEqual([WTTJ_DEFAULT_CREDENTIALS_SEED_URL]);
    });
  });

  describe('refreshWttjCredentials', () => {
    it('reads new credentials from the first seed page that has them', async () => {
      rememberWttjDetailUrl(DETAIL_URL);
      const fetchHtml = jest.fn(async (url: string) => (url === DETAIL_URL ? '<html>no config</html>' : DETAIL_HTML));
      const stale = currentWttjCredentials();

      const fresh = await refreshWttjCredentials(stale, fetchHtml);

      expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([DETAIL_URL, WTTJ_DEFAULT_CREDENTIALS_SEED_URL]);
      expect(fresh).toMatchObject({ appId: 'TESTAPP123', apiKey: FRESH_KEY, indexPrefix: 'wttj_jobs_production' });
      expect(fresh!.fetchedAt).toBeGreaterThan(0);
      expect(currentWttjCredentials()).toMatchObject({ apiKey: FRESH_KEY });
    });

    it('keeps the current prefix when the page carries none', async () => {
      const fetchHtml = jest.fn(
        async () => `"ALGOLIA_APPLICATION_ID":"TESTAPP123","ALGOLIA_API_KEY_CLIENT":"${FRESH_KEY}"`,
      );
      const fresh = await refreshWttjCredentials(currentWttjCredentials(), fetchHtml);
      expect(fresh?.indexPrefix).toBe(WTTJ_ALGOLIA_JOBS_INDEX_PREFIX);
    });

    it('a failing page is skipped; no usable page gives null', async () => {
      const fetchHtml = jest.fn(async () => {
        throw new Error('socket hang up');
      });
      await expect(refreshWttjCredentials(currentWttjCredentials(), fetchHtml)).resolves.toBeNull();
      expect(currentWttjCredentials().apiKey).toBe(WTTJ_ALGOLIA_API_KEY);
    });

    it('is single-flight: concurrent refusals share one refresh', async () => {
      let release: (html: string) => void = () => undefined;
      const fetchHtml = jest.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
      const stale = currentWttjCredentials();
      const a = refreshWttjCredentials(stale, fetchHtml);
      const b = refreshWttjCredentials(stale, fetchHtml);
      release(DETAIL_HTML);
      const [ra, rb] = await Promise.all([a, b]);
      expect(fetchHtml).toHaveBeenCalledTimes(1);
      expect(ra?.apiKey).toBe(FRESH_KEY);
      expect(rb?.apiKey).toBe(FRESH_KEY);
    });

    it('a caller holding already-replaced credentials gets the current ones without a fetch', async () => {
      const stale = currentWttjCredentials();
      await refreshWttjCredentials(stale, jest.fn(async () => DETAIL_HTML), 1_000);
      const fetchHtml = jest.fn(async () => DETAIL_HTML);
      const again = await refreshWttjCredentials(stale, fetchHtml, 2_000);
      expect(fetchHtml).not.toHaveBeenCalled();
      expect(again?.apiKey).toBe(FRESH_KEY);
    });

    it('refreshes at most once per cooldown window', async () => {
      const failing = jest.fn(async () => null);
      await refreshWttjCredentials(currentWttjCredentials(), failing, 1_000_000);
      const calls = failing.mock.calls.length;

      const within = jest.fn(async () => DETAIL_HTML);
      await expect(
        refreshWttjCredentials(currentWttjCredentials(), within, 1_000_000 + WTTJ_CREDENTIAL_REFRESH_COOLDOWN_MS - 1),
      ).resolves.toBeNull();
      expect(within).not.toHaveBeenCalled();

      const after = await refreshWttjCredentials(
        currentWttjCredentials(),
        within,
        1_000_000 + WTTJ_CREDENTIAL_REFRESH_COOLDOWN_MS,
      );
      expect(calls).toBeGreaterThan(0);
      expect(within).toHaveBeenCalledTimes(1);
      expect(after?.apiKey).toBe(FRESH_KEY);
    });

    it('returns the credentials even when they did not change', async () => {
      const same = `"ALGOLIA_APPLICATION_ID":"${WTTJ_ALGOLIA_APP_ID}","ALGOLIA_API_KEY_CLIENT":"${WTTJ_ALGOLIA_API_KEY}"`;
      const stale = currentWttjCredentials();
      const fresh = await refreshWttjCredentials(stale, jest.fn(async () => same));
      expect(fresh && sameWttjCredentials(fresh, stale)).toBe(true);
    });

    it('reset restores the constants', async () => {
      await refreshWttjCredentials(currentWttjCredentials(), jest.fn(async () => DETAIL_HTML));
      resetWttjCredentialCache();
      expect(currentWttjCredentials().apiKey).toBe(WTTJ_ALGOLIA_API_KEY);
    });
  });
});
