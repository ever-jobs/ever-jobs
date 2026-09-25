import {
  describeUrlForLog,
  isPubliclyRoutableHostname,
  pinUrlToHosts,
  PIN_URL_MAX_LENGTH,
} from '../src/utils/url-guard';

describe('pinUrlToHosts (Spec 1689)', () => {
  const ACME = ['acme.com'];

  describe('accepts', () => {
    it('an https URL on the allowed host and returns the normalised href', () => {
      expect(pinUrlToHosts('https://acme.com/careers', ACME)).toBe('https://acme.com/careers');
      expect(pinUrlToHosts('https://acme.com', ACME)).toBe('https://acme.com/');
    });

    it('a subdomain on a dot boundary', () => {
      expect(pinUrlToHosts('https://www.acme.com/jobs?x=1', ACME)).toBe(
        'https://www.acme.com/jobs?x=1',
      );
      expect(pinUrlToHosts('https://a.b.acme.com/', ACME)).toBe('https://a.b.acme.com/');
    });

    it('a schemeless value, read as https', () => {
      expect(pinUrlToHosts('www.acme.com/careers', ACME)).toBe('https://www.acme.com/careers');
      expect(pinUrlToHosts('//acme.com/careers', ACME)).toBe('https://acme.com/careers');
    });

    it('surrounding whitespace', () => {
      expect(pinUrlToHosts('  https://acme.com/careers \n', ACME)).toBe(
        'https://acme.com/careers',
      );
    });

    it('uppercase schemes, hosts and allowlist entries', () => {
      expect(pinUrlToHosts('HTTPS://WWW.ACME.COM/Careers', ACME)).toBe(
        'https://www.acme.com/Careers',
      );
      expect(pinUrlToHosts('https://www.acme.com/', ['ACME.COM'])).toBe('https://www.acme.com/');
    });

    it('a single trailing root dot on the host or the allowlist entry', () => {
      expect(pinUrlToHosts('https://www.acme.com./careers', ACME)).toBe(
        'https://www.acme.com./careers',
      );
      expect(pinUrlToHosts('https://www.acme.com/', ['acme.com.'])).toBe('https://www.acme.com/');
    });

    it('the default port, which normalises away', () => {
      expect(pinUrlToHosts('https://acme.com:443/careers', ACME)).toBe('https://acme.com/careers');
    });

    it('a fragment, keeping the host check on the real host', () => {
      expect(pinUrlToHosts('https://acme.com/careers#@evil.com', ACME)).toBe(
        'https://acme.com/careers#@evil.com',
      );
    });

    it('lenient allowlist entries (wildcard prefix, full URL)', () => {
      expect(pinUrlToHosts('https://jobs.acme.com/', ['*.acme.com'])).toBe('https://jobs.acme.com/');
      expect(pinUrlToHosts('https://jobs.acme.com/', ['https://acme.com/'])).toBe(
        'https://jobs.acme.com/',
      );
    });

    it('any one of several allowed hosts', () => {
      expect(pinUrlToHosts('https://airtable.com/app/pag1/form', ['linkedin.com', 'airtable.com'])).toBe(
        'https://airtable.com/app/pag1/form',
      );
    });
  });

  describe('refuses', () => {
    it.each([
      [undefined],
      [null],
      [''],
      ['   '],
      ['not a url at all'],
      ['https://'],
    ])('empty or malformed input %p', (raw) => {
      expect(pinUrlToHosts(raw as string | undefined | null, ACME)).toBeNull();
    });

    it('a lookalike host without a dot boundary', () => {
      expect(pinUrlToHosts('https://evilacme.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('https://acme.com.evil.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('https://acmexcom/', ACME)).toBeNull();
    });

    it('an off-domain host', () => {
      expect(pinUrlToHosts('https://evil.com/careers', ACME)).toBeNull();
      expect(pinUrlToHosts('https://evil.com/acme.com/careers', ACME)).toBeNull();
      expect(pinUrlToHosts('https://evil.com/?u=https://acme.com', ACME)).toBeNull();
    });

    it('userinfo smuggling in every spelling', () => {
      expect(pinUrlToHosts('https://acme.com@evil.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('https://user:pass@acme.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('https://user@acme.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('https://acme.com:x@evil.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('acme.com@169.254.169.254/latest/meta-data/', ACME)).toBeNull();
    });

    it('a fragment or backslash that hides the real host', () => {
      expect(pinUrlToHosts('https://evil.com#.acme.com', ACME)).toBeNull();
      expect(pinUrlToHosts('https://evil.com\\@acme.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('https://evil.com\\.acme.com/', ACME)).toBeNull();
      expect(pinUrlToHosts('https://evil.com?.acme.com', ACME)).toBeNull();
    });

    it('a double trailing dot', () => {
      expect(pinUrlToHosts('https://acme.com../', ACME)).toBeNull();
    });

    it('http by default, but accepts it with allowHttp and upgrades it with upgradeHttp', () => {
      expect(pinUrlToHosts('http://acme.com/careers', ACME)).toBeNull();
      expect(pinUrlToHosts('http://acme.com/careers', ACME, { allowHttp: true })).toBe(
        'http://acme.com/careers',
      );
      expect(pinUrlToHosts('http://acme.com/careers', ACME, { upgradeHttp: true })).toBe(
        'https://acme.com/careers',
      );
    });

    it('non-http schemes even with allowHttp', () => {
      for (const raw of [
        'file:///etc/passwd',
        'ftp://acme.com/x',
        'javascript:alert(1)',
        'data:text/html,<p>acme.com</p>',
        'mailto:jobs@acme.com',
        'ws://acme.com/',
        'gopher://acme.com/',
      ]) {
        expect(pinUrlToHosts(raw, ACME, { allowHttp: true, upgradeHttp: true })).toBeNull();
      }
    });

    it('an explicit non-default port unless allowPort', () => {
      expect(pinUrlToHosts('https://acme.com:6443/api', ACME)).toBeNull();
      expect(pinUrlToHosts('https://acme.com:6443/api', ACME, { allowPort: true })).toBe(
        'https://acme.com:6443/api',
      );
      expect(pinUrlToHosts('10.0.0.1:6443/?x=.acme.com', ACME)).toBeNull();
    });

    it('subdomains when allowSubdomains is false', () => {
      expect(pinUrlToHosts('https://acme.com/x', ACME, { allowSubdomains: false })).toBe(
        'https://acme.com/x',
      );
      expect(pinUrlToHosts('https://www.acme.com/x', ACME, { allowSubdomains: false })).toBeNull();
    });

    it('IP literals and internal names even when they are allowlisted', () => {
      expect(pinUrlToHosts('https://127.0.0.1/', ['127.0.0.1'])).toBeNull();
      expect(pinUrlToHosts('https://[::1]/', ['[::1]'])).toBeNull();
      expect(pinUrlToHosts('https://[::ffff:127.0.0.1]/', ['acme.com'])).toBeNull();
      expect(pinUrlToHosts('https://localhost/', ['localhost'])).toBeNull();
      expect(pinUrlToHosts('https://api.svc/', ['svc'])).toBeNull();
      expect(pinUrlToHosts('https://kubernetes.default.svc/version', ACME)).toBeNull();
      expect(pinUrlToHosts('https://2130706433/', ACME)).toBeNull();
    });

    it('an empty allowlist', () => {
      expect(pinUrlToHosts('https://acme.com/', [])).toBeNull();
      expect(pinUrlToHosts('https://acme.com/', ['', '  ', '/'])).toBeNull();
    });

    it('input longer than the cap', () => {
      const long = `https://acme.com/${'a'.repeat(PIN_URL_MAX_LENGTH)}`;
      expect(pinUrlToHosts(long, ACME)).toBeNull();
    });
  });

  it('returns a string whose re-parse lands on the checked host', () => {
    const tricky = [
      'https://acme.com\t.evil.com/',
      'https://acme.com%2eevil.com/',
      'https://www.acme.com\n/careers',
      'https://ACME.com/%2e%2e/%2e%2e/etc',
    ];
    for (const raw of tricky) {
      const pinned = pinUrlToHosts(raw, ACME);
      if (pinned === null) continue;
      const host = new URL(pinned).hostname;
      expect(host === 'acme.com' || host.endsWith('.acme.com')).toBe(true);
    }
  });
});

describe('isPubliclyRoutableHostname (Spec 1689)', () => {
  it.each([
    'acme.com',
    'www.4earth.tech',
    'starcloud.octbr.ai',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '[2606:4700::1111]',
    '2606:4700::1111',
    'ACME.COM',
    'acme.com.',
  ])('accepts public host %s', (host) => {
    expect(isPubliclyRoutableHostname(host)).toBe(true);
  });

  it.each([
    // loopback / unspecified / this-host
    'localhost',
    'localhost.',
    'foo.localhost',
    '127.0.0.1',
    '127.1',
    '0.0.0.0',
    '0',
    // private / link-local / CGNAT / benchmarking / docs / multicast
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.200',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    // alternative IPv4 spellings of loopback / metadata
    '2130706433',
    '0x7f000001',
    '0x7f.0.0.1',
    '0177.0.0.1',
    '%31%32%37.0.0.1',
    '0xa9.0xfe.0xa9.0xfe',
    // IPv6
    '::1',
    '[::1]',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    // IPv4 inside IPv6
    '::ffff:127.0.0.1',
    '[::ffff:127.0.0.1]',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '[::ffff:10.0.0.1]',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::10.1.2.3',
    '2002:7f00:1::',
    '2002:c0a8:0101::1',
    // names that only resolve inside a private network
    'intranet',
    'kubernetes',
    'kubernetes.default.svc',
    'api.default.svc.cluster.local',
    'printer.local',
    'metadata.google.internal',
    'router.home.arpa',
    'db.lan',
    'x.test',
    'x.invalid',
    'x.example',
    // not a hostname at all
    '',
    '   ',
    'acme.com/path',
    'user@acme.com',
    'acme.com:8080',
    'acme.com#frag',
    'acme.com?q',
    'acme .com',
    'foo.123',
  ])('refuses non-public host %p', (host) => {
    expect(isPubliclyRoutableHostname(host)).toBe(false);
  });

  it('refuses non-string input', () => {
    expect(isPubliclyRoutableHostname(undefined)).toBe(false);
    expect(isPubliclyRoutableHostname(null)).toBe(false);
  });

  it('accepts IPv4-mapped public addresses', () => {
    expect(isPubliclyRoutableHostname('::ffff:8.8.8.8')).toBe(true);
    expect(isPubliclyRoutableHostname('64:ff9b::808:808')).toBe(true);
  });

  it.each([
    'kubernetes.default',
    'kube-dns.kube-system',
    'metrics.kube-public',
    'pg-rw.ever-gauzy-prod',
    'minio.minio-tenant',
  ])('refuses the two-label in-cluster service name %s', (host) => {
    expect(isPubliclyRoutableHostname(host)).toBe(false);
  });

  it('still accepts IDN (xn--) TLDs and hyphenated non-final labels', () => {
    expect(isPubliclyRoutableHostname('example.xn--p1ai')).toBe(true);
    expect(isPubliclyRoutableHostname('my-company.co.uk')).toBe(true);
    expect(isPubliclyRoutableHostname('jobs.lever.co')).toBe(true);
  });
});

describe('describeUrlForLog (Spec 1689)', () => {
  it('keeps only the host: userinfo, path, query and fragment never reach a log', () => {
    expect(describeUrlForLog('https://user:secret@ampflame.com/careers?token=abc#x')).toBe('ampflame.com');
    expect(describeUrlForLog('http://evil.example:8080/latest/meta-data/')).toBe('evil.example:8080');
    expect(describeUrlForLog('www.acme.com/careers?api_key=k')).toBe('www.acme.com');
    expect(describeUrlForLog('//acme.com/x')).toBe('acme.com');
  });

  it('never throws and never echoes an unparseable value', () => {
    for (const raw of [undefined, null, '', '   ', 'https://', 'http://[::1', 'file:///etc/passwd']) {
      const out = describeUrlForLog(raw);
      expect(out).not.toContain('passwd');
      expect(typeof out).toBe('string');
    }
    expect(describeUrlForLog('http://[::1')).toBe('<unparseable>');
  });
});
