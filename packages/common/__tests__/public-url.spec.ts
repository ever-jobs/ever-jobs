import { API_URL_PATTERN, firstPublicUrl, isApiLikeUrl } from '../src/utils/public-url';

describe('isApiLikeUrl (Spec 1751)', () => {
  it.each([
    'https://api.smartrecruiters.com/v1/companies/AbbVie/postings/3743990015679966',
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1',
    'https://api.reliefweb.int/v1/jobs/4012345',
    'https://app.loxo.co/api/acme/jobs/9',
    'https://pam-stilling-feed.nav.no/api/v1/feedentry/abc',
    '/api/v1/feedentry/abc',
    'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
    'https://public-rest33.bullhornstaffing.com/rest-services/abc/entity/JobOrder/1',
    'https://graphql.eu.roubler.com/',
    'https://www.metacareers.com/graphql',
    'https://example.com/jobs/feed.json',
    'https://x.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions',
    'HTTPS://API.EXAMPLE.COM/jobs/1',
  ])('flags %s', (url) => {
    expect(isApiLikeUrl(url)).toBe(true);
  });

  it.each([
    'https://jobs.smartrecruiters.com/AbbVie/3743990015679966',
    'https://jobs.smartrecruiters.com/AbbVie/3743990015679966-head-of-ai?oga=true',
    'https://boards.greenhouse.io/acme/jobs/1',
    'https://job-boards.greenhouse.io/acme/jobs/1',
    'https://jobs.lever.co/acme/0b1c',
    'https://reliefweb.int/job/4012345/programme-officer',
    'https://arbeidsplassen.nav.no/stillinger/stilling/abc',
    'https://www.happiness.com/careers/api-engineer',
    'https://acme.com/rapid-apis/jobs',
    'https://www.paycomonline.net/v4/ats/web.php/portal/ABC/jobs/1',
  ])('does not flag %s', (url) => {
    expect(isApiLikeUrl(url)).toBe(false);
  });

  it('treats non-strings and blanks as not API URLs', () => {
    expect(isApiLikeUrl(null)).toBe(false);
    expect(isApiLikeUrl(undefined)).toBe(false);
    expect(isApiLikeUrl('   ')).toBe(false);
  });

  it('exposes the pattern the static plugin guard uses', () => {
    expect(API_URL_PATTERN.test('https://api.x.com/')).toBe(true);
  });
});

describe('firstPublicUrl (Spec 1751)', () => {
  it('returns the first absolute, non-API http(s) candidate, trimmed', () => {
    expect(
      firstPublicUrl(
        null,
        undefined,
        '  ',
        'https://api.smartrecruiters.com/v1/companies/A/postings/1',
        '/relative/path',
        'javascript:alert(1)',
        'mailto:jobs@acme.com',
        '  https://jobs.smartrecruiters.com/A/1  ',
        'https://later.example.com/',
      ),
    ).toBe('https://jobs.smartrecruiters.com/A/1');
  });

  it('returns null when nothing qualifies', () => {
    expect(firstPublicUrl()).toBeNull();
    expect(firstPublicUrl('https://api.x.com/1', 'not a url')).toBeNull();
  });

  it('accepts plain http', () => {
    expect(firstPublicUrl('http://www.circleci.com/careers/jobs/1')).toBe(
      'http://www.circleci.com/careers/jobs/1',
    );
  });
});
