import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Octopus Energy Group — Renewable-energy retailer and technology group serving households across multiple countries.
 *
 * Octopus Energy Group is a renewable-focused energy retailer and technology
 * company that supplies electricity and gas to households, invests in
 * renewable generation, and licenses its Kraken energy platform
 * internationally.
 *
 * Sector: Energy / Utilities. HQ: London, England, United Kingdom.
 *
 * Source: Lever job board, company slug `octoenergy`
 * (`https://jobs.lever.co/octoenergy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'octoenergy';
const COMPANY_NAME = 'Octopus Energy Group';

@SourcePlugin({
  site: Site.OCTOPUS_ENERGY_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OctopusEnergyGroupService implements IScraper {
  private readonly logger = new Logger(OctopusEnergyGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Octopus Energy Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Octopus Energy Group: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OCTOPUS_ENERGY_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'octoenergy-');
      }
    }

    this.logger.log(`Octopus Energy Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
