import 'reflect-metadata';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { ScraperInputDto, Site } from '@ever-jobs/models';

/**
 * USAJobs' crawl-policy opt-in (Spec 1690 §4.2): the Search API requires the
 * registered e-mail as `User-Agent`, so the plugin declares that UA and opts into
 * `userAgentMode: 'plugin'` with a reason. Only the HTTP client is faked; policy
 * resolution uses the real resolver.
 */

const mockCreateHttpClient = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args) };
});

import { explainCrawlPolicy, readCrawlPolicyEnv } from '@ever-jobs/common';
import { UsajobsService } from '../src/usajobs.service';
import { USAJOBS_CRAWL_POLICY } from '../src/usajobs.constants';

const manifest = () => Reflect.getMetadata(SOURCE_PLUGIN_METADATA, UsajobsService);

describe('USAJobs crawl policy (Spec 1690)', () => {
  it('declares a userAgentMode "plugin" opt-in with a documented reason', () => {
    expect(manifest()).toMatchObject({ site: Site.USAJOBS, crawl: USAJOBS_CRAWL_POLICY });
    expect(manifest().crawl).toEqual({
      userAgentMode: 'plugin',
      userAgentReason: expect.stringMatching(/User-Agent.*e-mail address registered with the API key/),
    });
  });

  it('opts into nothing but the UA mode (pacing stays with the global policy)', () => {
    expect(Object.keys(USAJOBS_CRAWL_POLICY).sort()).toEqual(['userAgentMode', 'userAgentReason']);
  });

  it('resolves to mode "plugin" (provenance plugin) under the default identify policy', () => {
    const explanation = explainCrawlPolicy({ site: Site.USAJOBS, plugin: manifest().crawl }, readCrawlPolicyEnv({}));

    expect(explanation.policy.userAgentMode).toBe('plugin');
    expect(explanation.policy.provenance.userAgentMode).toBe('plugin');
    expect(explanation.userAgentReason).toBe(USAJOBS_CRAWL_POLICY.userAgentReason);
  });

  it('is ignored when the operator pins EVER_JOBS_CRAWL_USER_AGENT_MODE=strict', () => {
    const env = readCrawlPolicyEnv({ EVER_JOBS_CRAWL_USER_AGENT_MODE: 'strict' });
    const explanation = explainCrawlPolicy({ site: Site.USAJOBS, plugin: manifest().crawl }, env);

    expect(explanation.policy.userAgentMode).toBe('strict');
    expect(explanation.userAgentReason).toBeUndefined();
  });

  it('declares the registered e-mail as User-Agent through setHeaders', async () => {
    const setHeaders = jest.fn();
    const get = jest.fn().mockResolvedValue({ data: { SearchResult: { SearchResultItems: [] } } });
    mockCreateHttpClient.mockReset().mockReturnValue({ get, post: jest.fn(), setHeaders });

    const input = new ScraperInputDto({
      siteType: [Site.USAJOBS],
      resultsWanted: 1,
      auth: { usajobs: { apiKey: 'test-key', email: 'ops@agency.example' } },
    } as Partial<ScraperInputDto>);
    await new UsajobsService().scrape(input);

    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ 'User-Agent': 'ops@agency.example', 'Authorization-Key': 'test-key' }),
    );
    expect(get).toHaveBeenCalled();
  });

  /** A REAL HttpClient (the factory's actual one) whose axios adapter records the wire headers. */
  function realClientRecording(sent: Array<Record<string, unknown>>, body: unknown) {
    const actual = jest.requireActual('@ever-jobs/common');
    mockCreateHttpClient.mockReset().mockImplementation((opts: unknown) => {
      const client = actual.createHttpClient(opts);
      client.getAxiosInstance().defaults.adapter = async (config: any) => {
        sent.push(config.headers.toJSON());
        return { data: body, status: 200, statusText: 'OK', headers: {}, config, request: {} };
      };
      return client;
    });
  }

  it('sends the registered e-mail on the wire when scrape() is called OUTSIDE any scrape context (CLI / e2e)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    realClientRecording(sent, { SearchResult: { SearchResultItems: [] } });

    await new UsajobsService().scrape(
      new ScraperInputDto({
        siteType: [Site.USAJOBS],
        resultsWanted: 1,
        auth: { usajobs: { apiKey: 'test-key', email: 'ops@agency.example' } },
      } as Partial<ScraperInputDto>),
    );

    expect(mockCreateHttpClient.mock.calls[0][0]).toMatchObject({ crawl: USAJOBS_CRAWL_POLICY });
    expect(sent).toHaveLength(1);
    expect(sent[0]['User-Agent']).toBe('ops@agency.example');
  });
});
