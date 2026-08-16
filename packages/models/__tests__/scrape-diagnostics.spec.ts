import {
  classifyScrapeError,
  looksLikeChallenge,
  ScrapeDiagnostics,
  SourceDiagnosticDto,
} from '../src/dtos/scrape-diagnostics.dto';

describe('classifyScrapeError (Spec 5082)', () => {
  it('classifies a Playwright launch failure as browser_unavailable', () => {
    const err = new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1000/chrome-linux/chrome\nrun: npx playwright install",
    );
    const d = classifyScrapeError(err);
    expect(d.reason).toBe('browser_unavailable');
    expect(d.detail).toContain("Executable doesn't exist");
  });

  it('classifies a timeout as timeout', () => {
    expect(classifyScrapeError(new Error('Navigation timeout of 30000 ms exceeded')).reason).toBe(
      'timeout',
    );
    expect(classifyScrapeError(new Error('deadline exceeded')).reason).toBe('timeout');
  });

  it('classifies a bot challenge / 403 as blocked', () => {
    expect(classifyScrapeError(new Error('Request failed with status 403 Forbidden')).reason).toBe(
      'blocked',
    );
    expect(classifyScrapeError(new Error('Just a moment... (Cloudflare)')).reason).toBe('blocked');
  });

  it('classifies transport errors as fetch_error', () => {
    expect(classifyScrapeError(new Error('connect ECONNREFUSED 127.0.0.1:443')).reason).toBe(
      'fetch_error',
    );
    expect(classifyScrapeError(new Error('getaddrinfo ENOTFOUND jobs.example.com')).reason).toBe(
      'fetch_error',
    );
  });

  it('falls back to unknown but preserves the message in detail', () => {
    const d = classifyScrapeError(new Error('something weird happened'));
    expect(d.reason).toBe('unknown');
    expect(d.detail).toBe('something weird happened');
  });

  it('truncates very long detail and tolerates non-Error values', () => {
    const long = classifyScrapeError(new Error('x'.repeat(1000)));
    expect(long.detail!.length).toBeLessThanOrEqual(300);
    expect(classifyScrapeError(undefined).reason).toBe('unknown');
    expect(classifyScrapeError('plain string blocked').reason).toBe('blocked');
  });

  it('folds in Error.code and non-Error name/code fields', () => {
    const axiosLike = Object.assign(new Error('connect failed'), {
      code: 'ETIMEDOUT',
    });
    expect(classifyScrapeError(axiosLike).reason).toBe('timeout');
    expect(classifyScrapeError({ name: 'TimeoutError' }).reason).toBe('timeout');
    expect(classifyScrapeError({ code: 'ENOTFOUND' }).reason).toBe('fetch_error');
  });
});

describe('looksLikeChallenge (Spec 5082)', () => {
  it('detects a Cloudflare interstitial', () => {
    expect(
      looksLikeChallenge('<html><title>Just a moment...</title><div id="cf-challenge"></div></html>'),
    ).toBe(true);
  });

  it('does not flag a normal board page', () => {
    expect(
      looksLikeChallenge('<html><body><a href="/postings/abc">Software Engineer</a></body></html>'),
    ).toBe(false);
  });

  it('handles empty html', () => {
    expect(looksLikeChallenge('')).toBe(false);
  });
});

describe('diagnostics DTOs (Spec 5082)', () => {
  it('omits detail when not provided', () => {
    const d = new ScrapeDiagnostics('empty');
    expect(d.reason).toBe('empty');
    expect(d.detail).toBeUndefined();
  });

  it('SourceDiagnosticDto carries site/count/reason/detail', () => {
    const s = new SourceDiagnosticDto('desktopmetal', 0, 'browser_unavailable', 'no chromium');
    expect(s).toEqual({
      site: 'desktopmetal',
      count: 0,
      reason: 'browser_unavailable',
      detail: 'no chromium',
    });
  });
});
