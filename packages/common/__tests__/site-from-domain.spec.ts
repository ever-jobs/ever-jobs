import {
  siteFromDomain,
  deriveSiteToken,
  normalizeCompanyHost,
} from '../src/utils/site-from-domain';
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

  it('no longer special-cases divergent.us / nuro.ai (Spec 5086)', () => {
    // Those two hostnames used to be hardcoded exceptions here. They are now
    // declared by the plugins themselves (`companyDomains`) and resolved by the
    // registry, so the pure string rule derives an unregistered token for them.
    expect(deriveSiteToken('divergent.us')).toBe('divergent_us');
    expect(siteFromDomain('divergent.us')).toBeUndefined();
    expect(deriveSiteToken('nuro.ai')).toBe('nuro_ai');
    expect(siteFromDomain('nuro.ai')).toBeUndefined();
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

describe('normalizeCompanyHost', () => {
  it('reduces bare, www and URL forms to the same host', () => {
    expect(normalizeCompanyHost('stokespace.com')).toBe('stokespace.com');
    expect(normalizeCompanyHost('  WWW.StokeSpace.com ')).toBe('stokespace.com');
    expect(normalizeCompanyHost('https://www.stokespace.com/careers/')).toBe('stokespace.com');
    expect(normalizeCompanyHost('//stokespace.com/careers')).toBe('stokespace.com');
  });

  it('keeps non-.com suffixes intact', () => {
    expect(normalizeCompanyHost('https://divergent.us/careers')).toBe('divergent.us');
    expect(normalizeCompanyHost('nuro.ai')).toBe('nuro.ai');
  });
});
