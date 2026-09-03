import { Injectable, Logger } from '@nestjs/common';
import { Site, IScraper } from '@ever-jobs/models';
import { normalizeCompanyHost } from '@ever-jobs/common';
import { IPluginMetadata } from '../interfaces/plugin-metadata.interface';

/**
 * Central registry holding all discovered source plugins.
 *
 * This singleton is populated by PluginDiscoveryService at bootstrap
 * and consumed by JobsService for dispatching scrape requests.
 */
@Injectable()
export class PluginRegistry {
  private readonly logger = new Logger(PluginRegistry.name);
  private readonly scraperMap = new Map<Site, IScraper>();
  private readonly metadataMap = new Map<Site, IPluginMetadata>();
  private readonly domainMap = new Map<string, Site>();

  /**
   * Register a plugin with its metadata and scraper implementation.
   */
  register(meta: IPluginMetadata, scraper: IScraper): void {
    if (this.scraperMap.has(meta.site)) {
      this.logger.warn(
        `Overwriting existing scraper for site: ${meta.site} (${meta.name})`,
      );
    }
    this.scraperMap.set(meta.site, scraper);
    this.metadataMap.set(meta.site, meta);
    this.indexCompanyDomains(meta);
  }

  /**
   * Index the domains a plugin declares it serves (Spec 5086).
   *
   * The first claim on a host wins: a later plugin claiming the same domain is
   * a declaration bug, and silently rerouting a company's traffic to whichever
   * plugin happened to register last would be the worst way to surface it.
   */
  private indexCompanyDomains(meta: IPluginMetadata): void {
    for (const raw of meta.companyDomains ?? []) {
      const host = normalizeCompanyHost(raw ?? '');
      if (!host) {
        continue;
      }
      const owner = this.domainMap.get(host);
      if (owner && owner !== meta.site) {
        this.logger.warn(
          `Domain ${host} already declared by ${owner}; ignoring claim from ${meta.site}`,
        );
        continue;
      }
      this.domainMap.set(host, meta.site);
    }
  }

  /**
   * Resolve a company domain or URL to the site that declared it (Spec 5086).
   *
   * Returns `undefined` when no plugin declares the host — callers fall back to
   * deriving a token from the domain.
   */
  siteForDomain(domainOrUrl: string): Site | undefined {
    const host = normalizeCompanyHost(domainOrUrl ?? '');
    return host ? this.domainMap.get(host) : undefined;
  }

  /**
   * Get the scraper implementation for a given site.
   */
  getScraper(site: Site): IScraper | undefined {
    return this.scraperMap.get(site);
  }

  /**
   * Check if a scraper is registered for a given site.
   */
  has(site: Site): boolean {
    return this.scraperMap.has(site);
  }

  /**
   * Get metadata for a registered plugin.
   */
  getMetadata(site: Site): IPluginMetadata | undefined {
    return this.metadataMap.get(site);
  }

  /**
   * List metadata for all registered plugins.
   */
  listSources(): IPluginMetadata[] {
    return Array.from(this.metadataMap.values());
  }

  /**
   * List all registered site keys.
   */
  listSiteKeys(): Site[] {
    return Array.from(this.scraperMap.keys());
  }

  /**
   * List all ATS sites (those requiring companySlug).
   */
  listAtsSites(): Site[] {
    return this.listSources()
      .filter((m) => m.isAts)
      .map((m) => m.site);
  }

  /**
   * Get the total number of registered plugins.
   */
  get size(): number {
    return this.scraperMap.size;
  }

  /**
   * Dynamically register an external scraper (for community plugins).
   */
  registerExternal(site: string, scraper: IScraper, name?: string): void {
    const siteKey = site.toLowerCase() as Site;
    const meta: IPluginMetadata = {
      site: siteKey,
      name: name ?? site,
      category: 'niche',
    };
    this.register(meta, scraper);
    this.logger.log(`Registered external plugin: ${siteKey}`);
  }
}
