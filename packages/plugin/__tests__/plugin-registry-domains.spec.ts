import * as fs from 'fs';
import * as path from 'path';

import { Site, IScraper } from '@ever-jobs/models';
import { PluginRegistry, IPluginMetadata } from '@ever-jobs/plugin';

const scraper: IScraper = { scrape: jest.fn() };

function meta(site: Site, companyDomains?: string[]): IPluginMetadata {
  return { site, name: String(site), category: 'company', companyDomains };
}

describe('PluginRegistry.siteForDomain (Spec 5086)', () => {
  it('resolves a declared domain', () => {
    const registry = new PluginRegistry();
    registry.register(meta(Site.STOKE_SPACE, ['stokespace.com']), scraper);

    expect(registry.siteForDomain('stokespace.com')).toBe(Site.STOKE_SPACE);
  });

  it('accepts www-prefixed and full-URL forms', () => {
    const registry = new PluginRegistry();
    registry.register(meta(Site.STOKE_SPACE, ['https://www.stokespace.com/careers/']), scraper);

    expect(registry.siteForDomain('stokespace.com')).toBe(Site.STOKE_SPACE);
    expect(registry.siteForDomain('WWW.StokeSpace.com')).toBe(Site.STOKE_SPACE);
    expect(registry.siteForDomain('https://stokespace.com/careers/current-openings/')).toBe(
      Site.STOKE_SPACE,
    );
  });

  it('resolves every domain a plugin declares', () => {
    const registry = new PluginRegistry();
    registry.register(meta(Site.DIVERGENT, ['divergent.us', 'divergent3d.com']), scraper);

    expect(registry.siteForDomain('divergent.us')).toBe(Site.DIVERGENT);
    expect(registry.siteForDomain('divergent3d.com')).toBe(Site.DIVERGENT);
  });

  it('returns undefined for an undeclared or empty domain', () => {
    const registry = new PluginRegistry();
    registry.register(meta(Site.STOKE_SPACE, ['stokespace.com']), scraper);

    expect(registry.siteForDomain('buildcover.com')).toBeUndefined();
    expect(registry.siteForDomain('')).toBeUndefined();
  });

  it('indexes nothing for a plugin that declares no domains', () => {
    const registry = new PluginRegistry();
    registry.register(meta(Site.BUILDCOVER), scraper);

    expect(registry.siteForDomain('buildcover.com')).toBeUndefined();
  });

  it('keeps the first claim on a host and warns about the second', () => {
    const registry = new PluginRegistry();
    const warn = jest.spyOn((registry as any).logger, 'warn').mockImplementation(() => undefined);

    registry.register(meta(Site.STOKE_SPACE, ['stokespace.com']), scraper);
    registry.register(meta(Site.VARDA_SPACE_INDUSTRIES, ['stokespace.com']), scraper);

    expect(registry.siteForDomain('stokespace.com')).toBe(Site.STOKE_SPACE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stokespace.com already declared'));
  });
});

/**
 * A typo'd declaration misroutes one company's request to another company's
 * board, silently. Nothing can detect a plausible wrong host in an unclaimed
 * namespace, but a host claimed twice is always a bug — assert it across the
 * whole catalogue rather than only the plugins a unit test happens to load.
 */
describe('declared company domains are unique across the catalogue (Spec 5086)', () => {
  const pluginsDir = path.resolve(__dirname, '../../plugins');

  function declarationsFor(pluginDir: string): string[] {
    const srcDir = path.join(pluginsDir, pluginDir, 'src');
    if (!fs.existsSync(srcDir)) {
      return [];
    }
    const hosts: string[] = [];
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      const match = source.match(/companyDomains:\s*\[([^\]]*)\]/);
      if (!match) {
        continue;
      }
      for (const raw of match[1].split(',')) {
        const host = raw.trim().replace(/^['"`]|['"`]$/g, '');
        if (host) {
          hosts.push(host.toLowerCase().replace(/^www\./, ''));
        }
      }
    }
    return hosts;
  }

  it('has no host claimed by two plugins', () => {
    const owners = new Map<string, string>();
    const conflicts: string[] = [];

    for (const dir of fs.readdirSync(pluginsDir)) {
      for (const host of declarationsFor(dir)) {
        const owner = owners.get(host);
        // Only a host claimed by two *different* plugins is a bug. One plugin
        // listing both `example.com` and `www.example.com` normalizes to a
        // single host, which `PluginRegistry.indexCompanyDomains` accepts
        // (`owner !== meta.site`); flagging it here reported a plugin as
        // conflicting with itself.
        if (owner && owner !== dir) {
          conflicts.push(`${host}: ${owner} and ${dir}`);
        } else if (!owner) {
          owners.set(host, dir);
        }
      }
    }

    expect(conflicts).toEqual([]);
    // The migrated exceptions plus the two mismatches that motivated the spec.
    expect(owners.get('stokespace.com')).toBe('source-company-stokespacetechnologies');
    expect(owners.get('varda.com')).toBe('source-company-vardaspace');
    expect(owners.get('divergent.us')).toBe('source-company-divergent');
    expect(owners.get('nuro.ai')).toBe('source-company-nuro');
  });
});
