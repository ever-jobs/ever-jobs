import 'reflect-metadata';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { ScraperInputDto, Site } from '@ever-jobs/models';

/**
 * HeadHunter's crawl-policy opt-in (Spec 1690 §4.2): the hh.ru API requires an
 * application-identifying `User-Agent`, so the plugin declares its app UA and opts
 * into `userAgentMode: 'plugin'` with a reason. Only the HTTP client is faked;
 * policy resolution uses the real resolver.
 */

const mockCreateHttpClient = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: (...args: unknown[]) => mockCreateHttpClient(...args) };
});

import { explainCrawlPolicy, readCrawlPolicyEnv } from '@ever-jobs/common';
import { HeadhunterService } from '../src/headhunter.service';
import { HEADHUNTER_CRAWL_POLICY, HEADHUNTER_HEADERS } from '../src/headhunter.constants';

const manifest = () => Reflect.getMetadata(SOURCE_PLUGIN_METADATA, HeadhunterService);

describe('HeadHunter crawl policy (Spec 1690)', () => {
  it('declares a userAgentMode "plugin" opt-in with a documented reason', () => {
    expect(manifest()).toMatchObject({ site: Site.HEADHUNTER, crawl: HEADHUNTER_CRAWL_POLICY });
    expect(manifest().crawl).toEqual({
      userAgentMode: 'plugin',
      userAgentReason: expect.stringMatching(/application-identifying User-Agent/),
    });
  });

  it('opts into nothing but the UA mode (pacing stays with the global policy)', () => {
    expect(Object.keys(HEADHUNTER_CRAWL_POLICY).sort()).toEqual(['userAgentMode', 'userAgentReason']);
  });

  it('resolves to mode "plugin" (provenance plugin) under the default identify policy', () => {
    const explanation = explainCrawlPolicy({ site: Site.HEADHUNTER, plugin: manifest().crawl }, readCrawlPolicyEnv({}));

    expect(explanation.policy.userAgentMode).toBe('plugin');
    expect(explanation.policy.provenance.userAgentMode).toBe('plugin');
    expect(explanation.userAgentReason).toBe(HEADHUNTER_CRAWL_POLICY.userAgentReason);
  });

  it('lets an operator site policy replace the app UA', () => {
    const env = readCrawlPolicyEnv({
      EVER_JOBS_CRAWL_POLICIES: JSON.stringify({
        sites: { headhunter: { userAgentMode: 'strict', userAgent: 'AcmeJobs/2.0 (ops@acme.example)' } },
      }),
    });
    const explanation = explainCrawlPolicy({ site: Site.HEADHUNTER, plugin: manifest().crawl }, env);

    expect(explanation.policy.userAgentMode).toBe('strict');
    expect(explanation.policy.userAgent).toBe('AcmeJobs/2.0 (ops@acme.example)');
    expect(explanation.policy.provenance.userAgentMode).toBe('operator-site');
  });

  it('is ignored under the legacy preset (strict mode, pre-1690 wire UA)', () => {
    const explanation = explainCrawlPolicy(
      { site: Site.HEADHUNTER, plugin: manifest().crawl },
      readCrawlPolicyEnv({ EVER_JOBS_CRAWL_PRESET: 'legacy' }),
    );

    expect(explanation.policy.userAgentMode).toBe('strict');
  });

  it('declares its app User-Agent through setHeaders', async () => {
    const setHeaders = jest.fn();
    const get = jest.fn().mockResolvedValue({ data: { items: [] } });
    mockCreateHttpClient.mockReset().mockReturnValue({ get, post: jest.fn(), setHeaders });

    await new HeadhunterService().scrape(
      new ScraperInputDto({ siteType: [Site.HEADHUNTER], resultsWanted: 1 } as Partial<ScraperInputDto>),
    );

    expect(HEADHUNTER_HEADERS['User-Agent']).toMatch(/^ever-jobs\/\d/);
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ 'User-Agent': HEADHUNTER_HEADERS['User-Agent'] }),
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

  it('sends its app UA on the wire when scrape() is called OUTSIDE any scrape context (CLI / e2e)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    realClientRecording(sent, { items: [] });

    await new HeadhunterService().scrape(
      new ScraperInputDto({ siteType: [Site.HEADHUNTER], resultsWanted: 1 } as Partial<ScraperInputDto>),
    );

    expect(mockCreateHttpClient.mock.calls[0][0]).toMatchObject({ crawl: HEADHUNTER_CRAWL_POLICY });
    expect(sent).toHaveLength(1);
    expect(sent[0]['User-Agent']).toBe(HEADHUNTER_HEADERS['User-Agent']);
  });
});
