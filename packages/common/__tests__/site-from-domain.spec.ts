import { siteFromDomain, deriveSiteToken } from '../src/utils/site-from-domain';
import { Site } from '@ever-jobs/models';

describe('siteFromDomain', () => {
  it('strips .com for .com domains', () => {
    expect(siteFromDomain('buildcover.com')).toBe(Site.BUILDCOVER);
    expect(siteFromDomain('flymotionus.com')).toBe(Site.FLYMOTIONUS);
    expect(siteFromDomain('https://www.vightaero.com/join-us/')).toBe(Site.VIGHTAERO);
  });

  it('replaces dots with underscores for non-.com domains', () => {
    expect(siteFromDomain('hyl.io')).toBe(Site.HYL_IO);
    expect(siteFromDomain('framework.co')).toBe(Site.FRAMEWORK_CO);
    expect(siteFromDomain('mara.inc')).toBe(Site.MARA_INC);
    expect(siteFromDomain('galadyne.io')).toBe(Site.GALADYNE_IO);
  });

  it('applies the divergent.us exception', () => {
    expect(siteFromDomain('divergent.us')).toBe(Site.DIVERGENT);
    expect(siteFromDomain('https://www.divergent.us/careers')).toBe(Site.DIVERGENT);
  });

  it('applies the nuro.ai exception', () => {
    expect(siteFromDomain('nuro.ai')).toBe(Site.NURO);
  });

  it('returns undefined for unknown domains', () => {
    expect(siteFromDomain('not-a-registered-plugin.io')).toBeUndefined();
    expect(siteFromDomain('foo.com')).toBeUndefined();
  });

  it('ignores leading/trailing whitespace', () => {
    expect(siteFromDomain('  buildcover.com  ')).toBe(Site.BUILDCOVER);
  });

  it('strips a leading www.', () => {
    expect(siteFromDomain('www.buildcover.com')).toBe(Site.BUILDCOVER);
  });
});

describe('deriveSiteToken', () => {
  it('returns the token without checking registration', () => {
    expect(deriveSiteToken('buildcover.com')).toBe('buildcover');
    expect(deriveSiteToken('hyl.io')).toBe('hyl_io');
    expect(deriveSiteToken('not-a-registered-plugin.io')).toBe('not-a-registered-plugin_io');
  });
});
