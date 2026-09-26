import * as http from 'http';
import type { AddressInfo } from 'net';
import { Logger } from '@nestjs/common';

import { EgressBlockedError } from '../src/http/crawl/errors';
import {
  BaseLookup,
  EGRESS_GUARD_ENV,
  assertPublicHostname,
  assertPublicProxy,
  assertPublicUrl,
  createGuardedLookup,
  egressBlockReason,
  getGuardedAgents,
  isEgressAllowListed,
  isPrivateAddress,
  normalizeHostLiteral,
  resetGuardedAgents,
} from '../src/http/crawl/egress-guard';

// The real module object (a namespace import may be a copy), so spies reach the guard.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dnsModule: typeof import('dns') = require('dns');

describe('isPrivateAddress — Spec 1690 §4.8', () => {
  it.each([
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.0.1',
    '192.168.255.255',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
  ])('IPv4 %s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.1',
    '93.184.216.34',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.1',
    '192.167.255.255',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
  ])('IPv4 %s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each([
    '::',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'FEBF::1',
    'fec0::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::FFFF:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:0:192.168.1.1',
    '::127.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b::127.0.0.1',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
    '2001:db8::1',
    '2001:0db8:ffff::1',
    '100::1',
  ])('IPv6 %s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2a00:1450::1'])(
    'IPv6 %s is public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it.each([
    ['2130706433', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['0x7f.1', '127.0.0.1'],
    ['0177.0.0.1', '127.0.0.1'],
    ['127.1', '127.0.0.1'],
    ['0', '0.0.0.0'],
    ['167772161', '10.0.0.1'],
    ['0xa9.0xfe.0xa9.0xfe', '169.254.169.254'],
  ])('normalizes the IPv4 shorthand %s the way a URL parser does (→ %s)', (literal, canonical) => {
    expect(new URL(`http://${literal}/`).hostname).toBe(canonical);
    expect(isPrivateAddress(literal)).toBe(true);
  });

  it('keeps public shorthand public', () => {
    expect(isPrivateAddress('134744072')).toBe(false); // 8.8.8.8
  });

  it('returns false for names and garbage', () => {
    for (const value of ['example.com', 'localhost', '', 'not an ip', '1.2.3.4.5', undefined as unknown as string]) {
      expect(isPrivateAddress(value)).toBe(false);
    }
  });
});

describe('normalizeHostLiteral', () => {
  it('canonicalizes like a WHATWG URL parser', () => {
    expect(normalizeHostLiteral('HTTP://User:pw@Example.COM.:8080/path?q#f')).toBe('example.com');
    expect(normalizeHostLiteral('Example.COM..')).toBe('example.com');
    expect(normalizeHostLiteral('jobs.example.com:8443')).toBe('jobs.example.com');
    expect(normalizeHostLiteral('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHostLiteral('[::FFFF:127.0.0.1]')).toBe('::ffff:7f00:1');
    expect(normalizeHostLiteral('2130706433')).toBe('127.0.0.1');
    expect(normalizeHostLiteral('')).toBe('');
    expect(normalizeHostLiteral('http://exa mple.com')).toBe('');
  });
});

describe('assertPublicHostname — Spec 1690 §4.8', () => {
  const originalAllow = process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS];

  afterEach(() => {
    if (originalAllow === undefined) delete process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS];
    else process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS] = originalAllow;
  });

  it.each([
    'localhost',
    'LOCALHOST.',
    'api.localhost',
    'printer.local',
    'vault.internal',
    'metadata.google.internal',
    'redis.svc',
    'api.ever-jobs.svc.cluster.local',
    'kube-dns.kube-system.svc.cluster.local',
    'node.cluster.local',
    'box.localdomain',
    'nas.home.arpa',
    'intranet',
    'mock',
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '0.0.0.0',
    '0',
    '2130706433',
    '0x7f.0.0.1',
    '[::1]',
    '::ffff:127.0.0.1',
    '[::ffff:a9fe:a9fe]',
    'fd00::1',
  ])('refuses %s', (host) => {
    expect(() => assertPublicHostname(host)).toThrow(EgressBlockedError);
  });

  it.each(['example.com', 'acme.softy.pro', 'boards-api.greenhouse.io', '8.8.8.8', '2606:4700:4700::1111', 'bücher.example', 'jobs.example.com.'])(
    'allows %s',
    (host) => {
      expect(() => assertPublicHostname(host)).not.toThrow();
    },
  );

  it('carries a stable code, the normalized target and a reason', () => {
    let caught: unknown;
    try {
      assertPublicHostname('API.Internal.');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EgressBlockedError);
    expect(caught).toMatchObject({ code: 'ERR_CRAWL_EGRESS_BLOCKED', target: 'api.internal' });
    expect((caught as EgressBlockedError).reason).toMatch(/internal/);
    expect(egressBlockReason('example.com')).toBeNull();
    expect(egressBlockReason('intranet')).toMatch(/dotless/);
    expect(egressBlockReason('')).toMatch(/empty/);
  });

  it.each([
    'http://example.com@127.0.0.1/',
    'http://user:pass@10.0.0.1:8080/x',
    'example.com@169.254.169.254',
    'http://127.0.0.1#@example.com/',
    'http://127.0.0.1\\@example.com/',
    'http://[::ffff:127.0.0.1]/',
    'http://0x7f.0.0.1/',
    'http://2130706433/',
    'http://localhost.:3000/',
  ])('sees through userinfo / fragment / encoding tricks: %s', (input) => {
    expect(() => assertPublicHostname(input)).toThrow(EgressBlockedError);
    if (input.startsWith('http')) expect(() => assertPublicUrl(input)).toThrow(EgressBlockedError);
  });

  it('assertPublicUrl judges the host the URL actually connects to', () => {
    expect(() => assertPublicUrl('https://127.0.0.1@example.com/')).not.toThrow(); // userinfo, host is example.com
    expect(() => assertPublicUrl('https://acme.softy.pro/offers?page=2')).not.toThrow();
    expect(() => assertPublicUrl('not a url')).toThrow(EgressBlockedError);
  });

  it(`exempts hosts listed in ${EGRESS_GUARD_ENV.ALLOW_HOSTS} or options.allowHosts`, () => {
    process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS] = ' localhost , *.corp.internal,10.0.0.5 ';
    expect(() => assertPublicHostname('localhost')).not.toThrow();
    expect(() => assertPublicHostname('ats.corp.internal')).not.toThrow();
    expect(() => assertPublicHostname('corp.internal')).toThrow(EgressBlockedError); // *.x does not match the apex
    expect(() => assertPublicHostname('10.0.0.5')).not.toThrow();
    expect(() => assertPublicHostname('10.0.0.6')).toThrow(EgressBlockedError);
    expect(() => assertPublicHostname('mock')).toThrow(EgressBlockedError);
    expect(() => assertPublicHostname('mock', { allowHosts: ['mock'] })).not.toThrow();
    expect(isEgressAllowListed('API.CORP.INTERNAL.')).toBe(true);
    delete process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS];
    expect(() => assertPublicHostname('localhost')).toThrow(EgressBlockedError);
  });
});

describe('assertPublicProxy — a caller-supplied proxy endpoint', () => {
  it.each([
    'http://user:pw@127.0.0.1:3128',
    '127.0.0.1:3128',
    'socks5://10.0.0.5:1080',
    'socks4://[::1]:1080',
    'http://redis.svc.cluster.local:6379',
    'http://2130706433:80',
    'http://intranet:8080',
  ])('refuses %s (credentials never in the message)', (proxy) => {
    expect(() => assertPublicProxy(proxy)).toThrow(EgressBlockedError);
    try {
      assertPublicProxy(proxy);
    } catch (err) {
      expect((err as Error).message).toMatch(/^Refusing to connect to proxy /);
      expect((err as Error).message).not.toContain('pw');
    }
  });

  it.each(['http://proxy.example:8080', 'socks5://p2.example:1080', 'p3.example:3128'])('allows %s', (proxy) => {
    expect(() => assertPublicProxy(proxy)).not.toThrow();
  });

  it('honours the allow list (per call and env)', () => {
    expect(() => assertPublicProxy('http://10.0.0.5:3128', { allowHosts: ['10.0.0.5'] })).not.toThrow();
  });
});

describe('createGuardedLookup — DNS-level guard', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS];
  });

  function base(addresses: Array<{ address: string; family: number }>, err?: NodeJS.ErrnoException): jest.Mock {
    return jest.fn(((_host, _opts, cb) => cb(err ?? null, err ? [] : addresses)) as BaseLookup);
  }

  function run(lookup: ReturnType<typeof createGuardedLookup>, host: string, options: unknown) {
    return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
      lookup(host, options as never, (err, address, family) => resolve({ err, address, family })),
    );
  }

  it('passes public answers through in single-address form', async () => {
    const resolver = base([{ address: '93.184.216.34', family: 4 }]);
    const result = await run(createGuardedLookup(resolver), 'example.com', { family: 0 });
    expect(result).toEqual({ err: null, address: '93.184.216.34', family: 4 });
    expect(resolver.mock.calls[0][1]).toMatchObject({ all: true, family: 0 });
  });

  it('supports options.all (Node autoSelectFamily) and returns every address', async () => {
    const list = [
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ];
    const result = await run(createGuardedLookup(base(list)), 'example.com', { all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual(list);
  });

  it('accepts the legacy numeric family and the callback-as-second-argument forms', async () => {
    const resolver = base([{ address: '93.184.216.34', family: 4 }]);
    const lookup = createGuardedLookup(resolver);
    expect((await run(lookup, 'example.com', 4)).address).toBe('93.184.216.34');
    expect(resolver.mock.calls[0][1]).toMatchObject({ family: 4, all: true });
    const viaTwoArgs = await new Promise<unknown>((resolve) =>
      lookup('example.com', ((err: unknown, address: unknown) => resolve({ err, address })) as never),
    );
    expect(viaTwoArgs).toEqual({ err: null, address: '93.184.216.34' });
  });

  it.each([
    [[{ address: '127.0.0.1', family: 4 }]],
    [[{ address: '10.0.0.7', family: 4 }]],
    [[{ address: '::ffff:169.254.169.254', family: 6 }]],
    [[{ address: 'fd00::5', family: 6 }]],
    [
      [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
    ],
  ])('refuses when ANY answer is private: %j', async (answers) => {
    for (const options of [{}, { all: true }]) {
      const result = await run(createGuardedLookup(base(answers)), 'evil.example', options);
      expect(result.err).toBeInstanceOf(EgressBlockedError);
      expect((result.err as unknown as EgressBlockedError).target).toBe('evil.example');
    }
  });

  it('passes resolver errors through and reports an empty answer as ENOTFOUND', async () => {
    const failure = Object.assign(new Error('getaddrinfo EAI_AGAIN x.example'), { code: 'EAI_AGAIN' });
    expect((await run(createGuardedLookup(base([], failure)), 'x.example', {})).err).toBe(failure);
    expect((await run(createGuardedLookup(base([])), 'x.example', {})).err?.code).toBe('ENOTFOUND');
    expect((await run(createGuardedLookup(base([])), 'x.example', { all: true })).address).toEqual([]);
  });

  it('lets an allow-listed host resolve to a private address', async () => {
    process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS] = 'mock.test.example';
    const result = await run(createGuardedLookup(base([{ address: '127.0.0.1', family: 4 }])), 'mock.test.example', {});
    expect(result).toEqual({ err: null, address: '127.0.0.1', family: 4 });
  });

  it('honours a per-lookup allow list (guardOptions.allowHosts) as well as the env one', async () => {
    const answer = base([{ address: '10.0.0.9', family: 4 }]);
    const allowed = await run(createGuardedLookup(answer, { allowHosts: ['*.corp.example'] }), 'intranet.corp.example', {});
    const refused = await run(createGuardedLookup(answer), 'intranet.corp.example', {});
    expect(allowed).toEqual({ err: null, address: '10.0.0.9', family: 4 });
    expect(refused.err).toBeInstanceOf(EgressBlockedError);
  });

  it('never names the private address in the refusal (no internal-DNS oracle); the server log has it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const result = await run(createGuardedLookup(base([{ address: '10.43.12.7', family: 4 }])), 'redis.ever-jobs-prod', {});
    expect(result.err).toBeInstanceOf(EgressBlockedError);
    expect(result.err!.message).not.toContain('10.43.12.7');
    expect(result.err!.message).toContain('resolves to a private address');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('10.43.12.7');
  });

  it('defeats DNS rebinding: every connection re-checks the answer dns.lookup gives now', async () => {
    const answers = ['93.184.216.34', '127.0.0.1'];
    const spy = jest.spyOn(dnsModule, 'lookup').mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (err: null, addresses: Array<{ address: string; family: number }>) => void,
    ) => cb(null, [{ address: answers.shift()!, family: 4 }])) as unknown as typeof dnsModule.lookup);

    const lookup = createGuardedLookup();
    const first = await run(lookup, 'rebind.example', {});
    expect(first).toEqual({ err: null, address: '93.184.216.34', family: 4 });
    const second = await run(lookup, 'rebind.example', {});
    expect(second.err).toBeInstanceOf(EgressBlockedError);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('getGuardedAgents', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetGuardedAgents();
  });

  it('shares one keep-alive pair per option set', () => {
    const verify = getGuardedAgents({ insecureTls: false });
    expect(getGuardedAgents({ insecureTls: false })).toBe(verify);
    const insecure = getGuardedAgents({ insecureTls: true });
    expect(insecure).not.toBe(verify);
    const open = getGuardedAgents({ insecureTls: false, guard: false });
    expect(open).not.toBe(verify);

    const opts = (agent: unknown) => (agent as { options: Record<string, unknown> }).options;
    expect(opts(verify.httpAgent).keepAlive).toBe(true);
    expect(opts(verify.httpsAgent).keepAlive).toBe(true);
    expect(typeof opts(verify.httpAgent).lookup).toBe('function');
    expect(typeof opts(verify.httpsAgent).lookup).toBe('function');
    expect(opts(verify.httpsAgent).rejectUnauthorized).toBeUndefined();
    expect(opts(insecure.httpsAgent).rejectUnauthorized).toBe(false);
    expect(opts(open.httpAgent).lookup).toBeUndefined();

    resetGuardedAgents();
    expect(getGuardedAgents({ insecureTls: false })).not.toBe(verify);
  });

  describe('against a real local server', () => {
    let server: http.Server;
    let port: number;
    let hits = 0;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        hits++;
        res.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function get(url: string, agent: http.Agent): Promise<{ status?: number; err?: Error }> {
      return new Promise((resolve) => {
        const req = http.get(url, { agent }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', (err) => resolve({ err }));
      });
    }

    it('the guarded agent refuses a name that resolves to loopback — the server never sees a request', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(dnsModule, 'lookup').mockImplementation(((
        _host: string,
        _opts: unknown,
        cb: (err: null, addresses: Array<{ address: string; family: number }>) => void,
      ) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as typeof dnsModule.lookup);

      const before = hits;
      const result = await get(`http://rebound.example:${port}/`, getGuardedAgents({ insecureTls: false }).httpAgent);
      expect(result.err).toBeInstanceOf(EgressBlockedError);
      expect(hits).toBe(before);
    });

    it('the unguarded shared agent (blockPrivateNetworks: false) still connects', async () => {
      jest.spyOn(dnsModule, 'lookup').mockImplementation(((
        _host: string,
        opts: { all?: boolean },
        cb: (err: null, address: unknown, family?: number) => void,
      ) =>
        opts && opts.all
          ? cb(null, [{ address: '127.0.0.1', family: 4 }])
          : cb(null, '127.0.0.1', 4)) as unknown as typeof dnsModule.lookup);

      const before = hits;
      const result = await get(`http://mock-server.example:${port}/`, getGuardedAgents({ insecureTls: false, guard: false }).httpAgent);
      expect(result).toEqual({ status: 200 });
      expect(hits).toBe(before + 1);
    });
  });
});
