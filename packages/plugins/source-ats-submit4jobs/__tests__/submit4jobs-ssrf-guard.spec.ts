import {
  isAllowedSubmit4jobsApiHost,
  SUBMIT4JOBS_EMBED_REGEX,
} from '../src/submit4jobs.constants';

/**
 * SSRF gate for the discovered embed API host.
 *
 * `apiHost` is capture group 1 of SUBMIT4JOBS_EMBED_REGEX — it comes from the
 * scraped tenant board's own HTML — and is then interpolated into the URLs we
 * request *with the ColdFusion session cookies attached*. The regex constrains
 * only the SHAPE of a host, so a tenant able to edit their board page could
 * otherwise redirect our scraper anywhere.
 */
describe('submit4jobs — apiHost allowlist', () => {
  it('accepts both real Pereless host families', () => {
    // Allowlisting only submit4jobs.com would silently break every tenant
    // served from the pereless.com host.
    expect(isAllowedSubmit4jobsApiHost('apps.submit4jobs.com')).toBe(true);
    expect(isAllowedSubmit4jobsApiHost('devapps.pereless.com')).toBe(true);
    expect(isAllowedSubmit4jobsApiHost('APPS.SUBMIT4JOBS.COM')).toBe(true);
  });

  it('rejects the hosts an attacker would actually aim at', () => {
    for (const host of [
      '169.254.169.254', // cloud metadata
      '10.0.0.5', // internal RFC1918
      '127.0.0.1',
      'localhost',
      'evil.example',
      'attacker.com',
    ]) {
      expect(isAllowedSubmit4jobsApiHost(host)).toBe(false);
    }
  });

  it('is not fooled by suffix-lookalikes or embedded credentials', () => {
    for (const host of [
      'evil.com/x.submit4jobs.com', // path smuggling
      'user@evil.com', // credential smuggling
      'evil.com#.submit4jobs.com', // fragment smuggling
      'evil.com:8080', // port
      'notsubmit4jobs.com', // missing dot boundary
      'submit4jobs.com.evil.com', // suffix in the middle
      '',
    ]) {
      expect(isAllowedSubmit4jobsApiHost(host)).toBe(false);
    }
  });

  it('the embed regex alone does NOT constrain the host — hence this guard', () => {
    // Proves the guard is load-bearing rather than redundant.
    const hostile =
      '<script src="//169.254.169.254/templates/magneto/embed/iframe.cfm?cid=1"></script>';
    const match = SUBMIT4JOBS_EMBED_REGEX.exec(hostile);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('169.254.169.254');
    expect(isAllowedSubmit4jobsApiHost(match![1])).toBe(false);
  });
});
