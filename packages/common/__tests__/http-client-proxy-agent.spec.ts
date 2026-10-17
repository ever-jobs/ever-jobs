import 'reflect-metadata';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { HttpClient } from '../src/http/http-client';

/**
 * Pins how `HttpClient` builds its proxy agents across the https-proxy-agent
 * v9 / socks-proxy-agent v10 majors (ESM-only packages: compiled by the jest
 * transform here, loaded through require(esm) at runtime). The egress guard's
 * `lookup` must still reach the socket that connects to the proxy itself, so
 * a proxy host resolving to a private address stays refused.
 *
 * Constructing an agent opens no connection: nothing here touches the network.
 */
describe('HttpClient.createAgent (proxy agents)', () => {
  const lookup = jest.fn();
  const createAgent = (proxy: string, guardedLookup?: unknown) =>
    (new HttpClient() as any).createAgent(proxy, guardedLookup);

  it('builds an HttpsProxyAgent for a bare host:port and hands the guarded lookup to its connect options', () => {
    const agent = createAgent('10.0.0.1:3128', lookup);

    expect(agent).toBeInstanceOf(HttpsProxyAgent);
    expect(agent.proxy.href).toBe('http://10.0.0.1:3128/');
    expect(agent.connectOpts.lookup).toBe(lookup);
  });

  it('keeps an explicit http:// proxy URL and adds no lookup when the proxy is trusted', () => {
    const agent = createAgent('http://proxy.test:8080');

    expect(agent).toBeInstanceOf(HttpsProxyAgent);
    expect(agent.proxy.href).toBe('http://proxy.test:8080/');
    expect(agent.connectOpts.lookup).toBeUndefined();
  });

  it('builds a SocksProxyAgent for socks5:// and hands the guarded lookup to its socket options', () => {
    const agent = createAgent('socks5://127.0.0.1:1080', lookup);

    expect(agent).toBeInstanceOf(SocksProxyAgent);
    expect(agent.proxy).toMatchObject({ host: '127.0.0.1', port: 1080, type: 5 });
    expect(agent.shouldLookup).toBe(true);
    expect(agent.socketOptions.lookup).toBe(lookup);
  });

  it('builds a SocksProxyAgent for socks4:// without socket options when the proxy is trusted', () => {
    const agent = createAgent('socks4://127.0.0.1:1080');

    expect(agent).toBeInstanceOf(SocksProxyAgent);
    expect(agent.proxy).toMatchObject({ host: '127.0.0.1', port: 1080, type: 4 });
    expect(agent.socketOptions).toBeNull();
  });
});
