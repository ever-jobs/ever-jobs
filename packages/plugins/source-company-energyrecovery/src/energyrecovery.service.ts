import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Energy Recovery — Manufacturer of pressure-exchanger energy-recovery devices for desalination and industrial refrigeration.
 *
 * Energy Recovery designs and manufactures pressure-exchanger technology
 * that captures and reuses energy in fluid-flow systems, primarily for
 * seawater desalination and, increasingly, for CO2-based refrigeration
 * systems.
 *
 * Sector: Energy efficiency / Water. HQ: San Leandro, California, USA.
 *
 * Source: Lever job board, company slug `energyrecovery`
 * (`https://jobs.lever.co/energyrecovery`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'energyrecovery';
const COMPANY_NAME = 'Energy Recovery';

@SourcePlugin({
  site: Site.ENERGY_RECOVERY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EnergyRecoveryService implements IScraper {
  private readonly logger = new Logger(EnergyRecoveryService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Energy Recovery',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Energy Recovery: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ENERGY_RECOVERY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'energyrecovery-');
      }
    }

    this.logger.log(`Energy Recovery: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
